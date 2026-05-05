/**
 * Roomba vacuum cleaner device for Matterbridge.
 * Wraps the RoboticVacuumCleaner base class and handles command routing.
 */
import { RoboticVacuumCleaner } from 'matterbridge/devices';
import { RvcRunMode, RvcCleanMode, RvcOperationalState } from 'matterbridge/matter/clusters';
import { buildSupportedAreas, buildSupportedMaps } from './serviceAreaBuilder.js';
import { RUN_MODE_IDLE, RUN_MODE_CLEANING, RUN_MODE_MAPPING, CLEAN_MODE_VACUUM, CLEAN_MODE_MOP, CLEAN_MODE_VACUUM_THEN_MOP, CLEAN_MODE_DEEP_CLEAN, CLEAN_MODE_MAX, CLEAN_MODE_QUICK, statusToRunMode, statusToOperationalState, errorCodeToMatterError, batteryToChargeLevel, } from './stateMapping.js';
// Run modes. `Mapping` triggers a training mission where the robot explores the
// floor without actually cleaning — used to build/refine the persistent map.
// Supported on every dorita980-compatible Roomba that has a pmap (j-series, s-series).
const SUPPORTED_RUN_MODES = [
    { label: 'Idle', mode: RUN_MODE_IDLE, modeTags: [{ value: RvcRunMode.ModeTag.Idle }] },
    { label: 'Cleaning', mode: RUN_MODE_CLEANING, modeTags: [{ value: RvcRunMode.ModeTag.Cleaning }] },
    { label: 'Mapping', mode: RUN_MODE_MAPPING, modeTags: [{ value: RvcRunMode.ModeTag.Mapping }] },
];
function buildSupportedCleanModes(family, caps) {
    const modes = [];
    const addVacuum = family !== 'mop';
    const addMop = family === 'mop' || family === 'swappable' || family === 'combo';
    const addCombo = family === 'combo';
    if (addVacuum) {
        modes.push({
            label: 'Vacuum',
            mode: CLEAN_MODE_VACUUM,
            modeTags: [
                { value: RvcCleanMode.ModeTag.Vacuum },
                { value: RvcCleanMode.ModeTag.Auto },
            ],
        });
        // Quick (single pass) — gated on the robot supporting pass selection. A
        // 600-series without multi-pass would silently ignore the preference write,
        // so we just don't offer the mode.
        if (caps.multiPass) {
            modes.push({
                label: 'Quick',
                mode: CLEAN_MODE_QUICK,
                modeTags: [
                    { value: RvcCleanMode.ModeTag.Vacuum },
                    { value: RvcCleanMode.ModeTag.Quick },
                    { value: RvcCleanMode.ModeTag.LowEnergy },
                ],
            });
        }
        // Max Power (performance boost) — gated on carpet boost support.
        if (caps.carpetBoost) {
            modes.push({
                label: 'Max Power',
                mode: CLEAN_MODE_MAX,
                modeTags: [
                    { value: RvcCleanMode.ModeTag.Vacuum },
                    { value: RvcCleanMode.ModeTag.Max },
                ],
            });
        }
        // Deep Clean (two-pass + carpet boost) — needs BOTH caps.
        if (caps.multiPass && caps.carpetBoost) {
            modes.push({
                label: 'Deep Clean',
                mode: CLEAN_MODE_DEEP_CLEAN,
                modeTags: [
                    { value: RvcCleanMode.ModeTag.Vacuum },
                    { value: RvcCleanMode.ModeTag.DeepClean },
                ],
            });
        }
    }
    if (addMop) {
        modes.push({
            label: 'Mop',
            mode: CLEAN_MODE_MOP,
            modeTags: [{ value: RvcCleanMode.ModeTag.Mop }],
        });
    }
    if (addCombo) {
        modes.push({
            label: 'Vacuum then Mop',
            mode: CLEAN_MODE_VACUUM_THEN_MOP,
            // Matter's VacuumThenMop tag is the semantic one; carry Vacuum+Mop too so
            // older controllers that only look at primary tags still understand it.
            modeTags: [
                { value: RvcCleanMode.ModeTag.VacuumThenMop },
                { value: RvcCleanMode.ModeTag.Vacuum },
                { value: RvcCleanMode.ModeTag.Mop },
            ],
        });
    }
    // Safety net — every family must contribute at least one mode for Matter
    // conformance. 'unknown' falls through to plain Vacuum.
    if (modes.length === 0) {
        modes.push({
            label: 'Vacuum',
            mode: CLEAN_MODE_VACUUM,
            modeTags: [{ value: RvcCleanMode.ModeTag.Vacuum }],
        });
    }
    return modes;
}
// Operational states.
// NOTE: `operationalStateLabel` is only allowed for manufacturer-specific IDs (128-191),
// not for the standard IDs used below — so we omit it.
const SUPPORTED_OP_STATES = [
    { operationalStateId: RvcOperationalState.OperationalState.Stopped },
    { operationalStateId: RvcOperationalState.OperationalState.Running },
    { operationalStateId: RvcOperationalState.OperationalState.Paused },
    { operationalStateId: RvcOperationalState.OperationalState.Error },
    { operationalStateId: RvcOperationalState.OperationalState.SeekingCharger },
    { operationalStateId: RvcOperationalState.OperationalState.Charging },
    { operationalStateId: RvcOperationalState.OperationalState.Docked },
];
export class RoombaDevice {
    connection;
    log;
    device;
    endpointActive = false;
    deviceName;
    serialNumber;
    serverMode;
    rooms;
    maps;
    pmapId;
    userPmapvId;
    roomCleanDurationMs;
    roomCleanSqft;
    /** Matter areaIds currently selected by the controller (from `selectAreas`). */
    selectedAreas = [];
    /** Wall-clock time the current multi-room mission started; fallback advance signal. */
    missionStartMs;
    /** Sqft cleaned at mission start; used for sqft-delta based advance (primary signal). */
    missionStartSqft;
    /**
     * Highest selectedAreas index we've reached this mission. Skip commands advance
     * us decisively (e.g. room 1 → room 2); the time-based fallback must never drag
     * us back to a room we've already left. This ratchet enforces monotonic progress.
     */
    missionMaxIndex = 0;
    family;
    iosAllRoomsWorkaround;
    /** Most recent RvcCleanMode the controller asked for. Checked at startCleaning time. */
    pendingCleanMode;
    constructor(connection, log, serialNumber, rooms, serverMode, pmapId, userPmapvId, roomCleanDurationMinutes, roomCleanSqft, family = 'unknown', maps = undefined, cleanCapabilities = { multiPass: false, carpetBoost: false }, iosAllRoomsWorkaround = true) {
        this.connection = connection;
        this.log = log;
        this.iosAllRoomsWorkaround = iosAllRoomsWorkaround;
        this.serverMode = serverMode;
        this.rooms = rooms ?? [];
        this.maps = maps ?? [];
        this.pmapId = pmapId;
        this.userPmapvId = userPmapvId;
        this.roomCleanDurationMs = Math.max(1, roomCleanDurationMinutes ?? 10) * 60_000;
        this.roomCleanSqft = Math.max(1, roomCleanSqft ?? 75);
        this.family = family;
        const supportedCleanModes = buildSupportedCleanModes(family, cleanCapabilities);
        // Prefer a Vacuum-tagged mode as the initial current value — matches what
        // every Roomba ships with when the bin is installed. For mop-only robots
        // fall back to the first (Mop) entry.
        const initialCleanMode = supportedCleanModes.find((m) => m.modeTags?.some((t) => t.value === RvcCleanMode.ModeTag.Vacuum))?.mode ??
            supportedCleanModes[0].mode;
        this.deviceName = connection.getDeviceName();
        this.serialNumber = serialNumber;
        const supportedAreas = buildSupportedAreas(rooms, maps);
        const supportedMaps = buildSupportedMaps(maps);
        // CurrentArea must reference a valid id in supportedAreas (or null); pick the first
        // configured area's id so Matter conformance is satisfied no matter what ids the
        // user chose.
        const currentArea = supportedAreas[0].areaId;
        // 'server' = independent Matter server node with its own QR/passcode (recommended for
        // RVC in Apple Home / Google Home). 'matter'/undefined = bridged under the aggregator.
        const mode = serverMode ? 'server' : undefined;
        this.device = new RoboticVacuumCleaner(this.deviceName, serialNumber, mode, RUN_MODE_IDLE, SUPPORTED_RUN_MODES, initialCleanMode, supportedCleanModes, undefined, // currentPhase
        undefined, // phaseList
        RvcOperationalState.OperationalState.Docked, SUPPORTED_OP_STATES, supportedAreas, [], // selectedAreas
        currentArea, supportedMaps);
        this.configureCommandHandlers();
        this.listenForStateUpdates();
    }
    /**
     * Apply identifying metadata (vendor, model, firmware) to the BridgedDeviceBasicInformation
     * cluster that Matterbridge adds when wrapping the device in the bridge aggregator.
     * Should be called BEFORE registering the device with Matterbridge.
     */
    applyIdentity(info, vendorName, modelOverride) {
        const model = modelOverride || info.sku || 'Roomba';
        const swNum = parseSoftwareVersion(info.softwareVer);
        const hwNum = parseHardwareVersion(info.hardwareVer);
        try {
            if (this.serverMode) {
                // Server mode: the device IS its own Matter server, so the controller reads
                // BasicInformation from this endpoint (not BridgedDeviceBasicInformation).
                // Matterbridge also requires productId to be set for server-mode endpoints —
                // `createDefaultBridgedDeviceBasicInformationClusterServer` clears it, so we
                // must NOT call that helper in server mode.
                this.device.createDefaultBasicInformationClusterServer(this.deviceName, this.serialNumber, 0xfff1, vendorName, 0x8000, model, swNum, info.softwareVer, hwNum, info.hardwareVer);
            }
            else {
                // Bridged mode: the controller reads BridgedDeviceBasicInformation from the
                // bridged endpoint. Call both so older controllers that read BasicInformation
                // get the right vendor/model too.
                this.device.createDefaultBasicInformationClusterServer(this.deviceName, this.serialNumber, 0xfff1, vendorName, 0x8000, model, swNum, info.softwareVer, hwNum, info.hardwareVer);
                this.device.createDefaultBridgedDeviceBasicInformationClusterServer(this.deviceName, this.serialNumber, 0xfff1, vendorName, model, swNum, info.softwareVer, hwNum, info.hardwareVer);
            }
            this.log.info(`Applied identity to ${this.deviceName}: vendor=${vendorName} model=${model} sw=${info.softwareVer} hw=${info.hardwareVer}`);
            this.log.debug(`  Endpoint fields now: vendorName="${this.device.vendorName}" productName="${this.device.productName}" productId=${this.device.productId} softwareVersionString="${this.device.softwareVersionString}" uniqueId="${this.device.uniqueId}" mode=${this.serverMode ? 'server' : 'bridged'}`);
            // Stash the values we want on the root node — they'll be pushed via
            // overrideRootNodeIdentity() AFTER matterbridge creates the server node, since
            // matterbridge's createServerNodeContext hardcodes softwareVersion to its OWN
            // version (e.g. 3.7.4) regardless of what we set on the endpoint.
            this.pendingRootOverride = {
                vendorName,
                productName: model,
                softwareVersion: swNum,
                softwareVersionString: info.softwareVer,
                hardwareVersion: hwNum,
                hardwareVersionString: info.hardwareVer,
            };
        }
        catch (err) {
            this.log.warn(`Failed to apply device identity: ${err}`);
        }
    }
    pendingRootOverride;
    /**
     * In server mode each device has its own Matter server node (root endpoint 0).
     * Matterbridge unconditionally stamps its own `softwareVersion`/`hardwareVersion`
     * into that root node's BasicInformation when creating the server, so users see
     * "Matterbridge 3.7.4" instead of the robot's firmware. We work around this by
     * writing the correct values back to the root node AFTER registration.
     *
     * These attributes are declared Fixed in the Matter spec, meaning a REMOTE
     * controller cannot write them — but the server itself can populate them at any
     * time before clients subscribe. matter.js's internal `set()` API respects that.
     */
    async overrideRootNodeIdentity() {
        if (!this.serverMode || !this.pendingRootOverride)
            return;
        // `serverNode` is attached by matterbridge in createDeviceServerNode — it's a
        // matter.js ServerNode whose endpoint-0 `basicInformation` we need to patch.
        const serverNode = this.device.serverNode;
        if (!serverNode || typeof serverNode.set !== 'function') {
            this.log.debug(`Server node not available yet for ${this.deviceName} — skipping root identity override`);
            return;
        }
        try {
            await serverNode.set({
                basicInformation: {
                    vendorName: this.pendingRootOverride.vendorName.slice(0, 32),
                    productName: this.pendingRootOverride.productName.slice(0, 32),
                    softwareVersion: this.pendingRootOverride.softwareVersion,
                    softwareVersionString: this.pendingRootOverride.softwareVersionString.slice(0, 64),
                    hardwareVersion: this.pendingRootOverride.hardwareVersion,
                    hardwareVersionString: this.pendingRootOverride.hardwareVersionString.slice(0, 64),
                },
            });
            this.log.info(`Root node identity overridden for ${this.deviceName}: ` +
                `vendorName=${this.pendingRootOverride.vendorName} ` +
                `productName=${this.pendingRootOverride.productName} ` +
                `softwareVersionString=${this.pendingRootOverride.softwareVersionString}`);
        }
        catch (err) {
            this.log.warn(`Failed to override root node identity for ${this.deviceName}: ${err}`);
        }
    }
    configureCommandHandlers() {
        // Identify: make the robot beep
        this.device.addCommandHandler('identify', async () => {
            this.log.info(`Identify requested for ${this.connection.getDeviceName()}`);
            try {
                await this.connection.find();
            }
            catch (err) {
                this.log.warn(`Failed to identify robot: ${err}`);
            }
        });
        // RvcRunMode: change run mode (start/stop cleaning).
        // If the controller has called `selectAreas` with one or more rooms, start a
        // room-targeted clean via the dorita980 `cleanRoom` command — otherwise a whole-home
        // clean. Roomba requires pmapId + userPmapvId for room cleans; if those aren't in
        // the config the room path degrades to a whole-home clean with a log warning.
        // RvcRunMode.changeToMode: start / stop / begin mapping run.
        // Fully-qualified name because the short key 'changeToMode' also targets
        // ModeSelect and would collide with RvcCleanMode.changeToMode (whose mode
        // ids 1-4 overlap with our run-mode ids numerically).
        this.device.addCommandHandler('RvcRunMode.changeToMode', async ({ request }) => {
            const newMode = request.newMode;
            this.log.info(`RvcRunMode.changeToMode requested: ${newMode}`);
            try {
                if (newMode === RUN_MODE_CLEANING) {
                    const status = this.connection.getStatus();
                    if (status.paused) {
                        await this.connection.resume();
                    }
                    else {
                        await this.startCleaning();
                    }
                }
                else if (newMode === RUN_MODE_MAPPING) {
                    this.log.info('Starting mapping / training run');
                    await this.connection.train();
                }
                else if (newMode === RUN_MODE_IDLE) {
                    await this.connection.stop();
                }
            }
            catch (err) {
                this.log.warn(`Failed to change run mode: ${err}`);
            }
        });
        // RvcCleanMode.changeToMode: record which clean mode the controller wants.
        // Matterbridge computes the actual ChangeToModeResponse internally (based on
        // supportedModes) and doesn't accept a return value from the handler — so
        // we can't cleanly reject "Mop on a bin-installed swappable" at this layer.
        // Instead we remember the pending mode, and gate it in startCleaning() so
        // the user sees the denial + reason when they actually press Clean.
        this.device.addCommandHandler('RvcCleanMode.changeToMode', async ({ request }) => {
            const newMode = request.newMode;
            this.pendingCleanMode = newMode;
            this.log.info(`RvcCleanMode.changeToMode requested: ${newMode}`);
            const denial = this.validateCleanMode(newMode);
            if (denial) {
                // Log only — matterbridge's cluster server will have already accepted
                // the mode change by the time we get here. The denial is surfaced at
                // startCleaning time if the user proceeds to press Clean.
                this.log.warn(`Clean mode ${newMode} currently unavailable: ${denial.statusText}`);
            }
        });
        // ServiceArea: record which rooms the controller wants cleaned. The actual
        // clean command is sent once the controller transitions RvcRunMode to Cleaning.
        //
        // Matter spec §1.17.7.1.1: `newAreas=[]` means "unconstrained" (clean
        // everywhere). iOS Home's room picker uses this when the user picks "All
        // Rooms" — but then re-renders the ticked-rooms UI from the SelectedAreas
        // attribute and shows *only the first configured room* ticked (looks like a
        // client UI bug; macOS Home renders the same empty-list attribute as "All
        // Rooms" correctly). Workaround: when newAreas is empty, internally treat
        // it as "whole-home" (startCleaning will dispatch `clean()` not
        // `cleanRoom()`), but mirror back the FULL list of configured areaIds to
        // the attribute so iOS Home's UI matches user intent.
        this.device.addCommandHandler('selectAreas', async ({ request }) => {
            const newAreas = (request.newAreas ?? []);
            this.selectedAreas = [...newAreas];
            this.log.info(`selectAreas requested: [${newAreas.join(', ')}]`);
            const useWorkaround = this.iosAllRoomsWorkaround && newAreas.length === 0 && this.rooms.length > 0;
            const mirrorValue = useWorkaround
                ? this.rooms.map((r) => r.areaId)
                : this.selectedAreas;
            try {
                this.device.setAttribute('serviceArea', 'selectedAreas', mirrorValue, this.log);
            }
            catch (err) {
                this.log.debug(`Failed to mirror selectedAreas: ${err}`);
            }
        });
        // ServiceArea.SkipArea: not wired up yet. Matterbridge's
        // `MatterbridgeServiceAreaServer` only forwards `selectAreas` to the plugin
        // command handler; `skipArea` would need an upstream addition to
        // CommandHandlerDataMap + the server override. Dorita980 also doesn't expose
        // a `skip()` method, so the downstream half is missing too. In the meantime,
        // skip commands from the iRobot app ARE detected via `lastCommand`
        // observations and flow through `handleRegionsSkipped` → currentArea advance
        // — which covers the user-facing path today.
        // RvcOperationalState: pause, resume, goHome
        this.device.addCommandHandler('pause', async () => {
            this.log.info('Pause requested');
            try {
                await this.connection.pause();
            }
            catch (err) {
                this.log.warn(`Failed to pause: ${err}`);
            }
        });
        this.device.addCommandHandler('resume', async () => {
            this.log.info('Resume requested');
            try {
                await this.connection.resume();
            }
            catch (err) {
                this.log.warn(`Failed to resume: ${err}`);
            }
        });
        this.device.addCommandHandler('goHome', async () => {
            this.log.info('Go home requested');
            try {
                // Some Roomba firmwares auto-resume a paused mission when the robot reaches
                // the dock — it bounces off, completes, redocks, loops. Sending `stop()`
                // first cancels the active/paused mission so the subsequent `dock()` results
                // in a clean single-dock with no mission to resume.
                const status = this.connection.getStatus();
                if (status.running || status.paused) {
                    this.log.debug('goHome: mission active, stopping before dock');
                    try {
                        await this.connection.stop();
                    }
                    catch (err) {
                        this.log.debug(`goHome: stop() returned ${err}; continuing to dock anyway`);
                    }
                    // Brief settle time so the robot processes the stop before we tell it to dock.
                    await new Promise((resolve) => setTimeout(resolve, 1500));
                }
                await this.connection.dock();
            }
            catch (err) {
                this.log.warn(`Failed to dock: ${err}`);
            }
        });
    }
    /**
     * Check whether the robot can currently perform the requested clean mode.
     * Returns an InvalidInMode response struct when it can't (with human-readable
     * `statusText` the controller surfaces to the user), or `null` when the mode
     * is fine to proceed.
     *
     * Matter spec: ModeBase.ChangeToModeResponse statuses —
     *   0 = Success, 1 = UnsupportedMode, 2 = GenericFailure, 3 = InvalidInMode.
     * We use InvalidInMode (3) for tool-mismatch cases; the controller interprets
     * that as "not possible right now" rather than "the device doesn't support it
     * at all", which matches the semantics on a swappable robot.
     */
    validateCleanMode(newMode) {
        const tool = this.connection.getStatus().installedTool;
        // Every vacuum-power preset (Vacuum / DeepClean / Max / Quick) requires the
        // bin to be installed on a swappable robot.
        const isVacuumMode = newMode === CLEAN_MODE_VACUUM ||
            newMode === CLEAN_MODE_DEEP_CLEAN ||
            newMode === CLEAN_MODE_MAX ||
            newMode === CLEAN_MODE_QUICK;
        const isMopMode = newMode === CLEAN_MODE_MOP;
        const isComboMode = newMode === CLEAN_MODE_VACUUM_THEN_MOP;
        if (this.family === 'swappable') {
            if (isMopMode && !tool.mopInstalled) {
                return {
                    status: 3,
                    statusText: 'Swap in the mop reservoir first — the bin is currently installed.',
                };
            }
            if (isVacuumMode && !tool.binInstalled) {
                return {
                    status: 3,
                    statusText: 'Swap in the dust bin first — the mop reservoir is currently installed.',
                };
            }
        }
        if ((isMopMode || isComboMode) && this.family === 'combo' && tool.padFaulted) {
            return { status: 3, statusText: 'Mop pad is missing or not detected. Reseat the pad.' };
        }
        // Combo & mop-only families accept mop modes unconditionally; the robot's
        // own "pad missing" error will surface via OperationalError if the user
        // starts cleaning without one.
        return null;
    }
    /**
     * Decide between a whole-home and a room-targeted clean based on the current
     * `selectedAreas`. Called when the controller transitions RvcRunMode -> Cleaning.
     */
    async startCleaning() {
        // Gate against tool-mismatch: swappable robots can't do Mop with the bin
        // installed or Vacuum with the mop reservoir installed. Throw early so the
        // user sees a helpful message in the log and Matter's RvcOperationalState
        // stays in whatever state it was, rather than going Running on a no-op clean.
        if (this.pendingCleanMode !== undefined) {
            const denial = this.validateCleanMode(this.pendingCleanMode);
            if (denial) {
                this.log.error(`Cannot start clean: selected clean mode ${this.pendingCleanMode} is unavailable — ${denial.statusText}`);
                throw new Error(denial.statusText);
            }
            // Apply the Roomba-side cleaning preset (carpet boost + passes) that
            // matches the selected Matter mode. The robot remembers these
            // persistently, so the subsequent `clean()`/`cleanRoom()` picks them up.
            const preset = matterModeToPreset(this.pendingCleanMode);
            if (preset) {
                try {
                    this.log.info(`Applying cleaning preset "${preset}" for mode ${this.pendingCleanMode}`);
                    await this.connection.applyCleaningPreset(preset);
                }
                catch (err) {
                    this.log.warn(`applyCleaningPreset(${preset}) failed: ${err} (continuing with previous preset)`);
                }
            }
        }
        if (this.selectedAreas.length === 0) {
            // Whole-home clean: clear any stale per-area state from a previous room mission.
            this.log.info('Starting whole-home clean (no areas selected)');
            this.setCurrentArea(null);
            await this.connection.clean();
            return;
        }
        this.log.info(`startCleaning: ${this.selectedAreas.length} area(s) selected: [${this.selectedAreas.join(', ')}]`);
        // Resolve Matter areaIds back to Roomba region metadata, and group by map
        // so we can verify the mission doesn't cross maps (the robot can't physically
        // clean rooms on two different pmaps in one mission — they're typically
        // different floors).
        const regions = [];
        const unmappedAreas = [];
        const selectedMapIds = new Set();
        for (const areaId of this.selectedAreas) {
            const room = this.rooms.find((r) => r.areaId === areaId);
            // Favorite/mission path: dispatch the saved job by favorite_id, replaying
            // the full region payload (including per-region params) captured at discovery.
            if (room?.favoriteId) {
                if (this.selectedAreas.length > 1) {
                    this.log.warn(`favoriteId area selected with other areas — only running the favorite for "${room.name}"`);
                }
                const missionMapId = room.mapId;
                const activeMap = missionMapId !== undefined ? this.maps.find((m) => m.mapId === missionMapId) : undefined;
                const pmapId = activeMap?.pmapId ?? this.pmapId;
                const userPmapvId = activeMap?.userPmapvId ?? this.userPmapvId;
                if (!pmapId) {
                    this.log.warn(`favoriteId area "${room.name}" has no pmapId — falling back to whole-home clean.`);
                    this.setCurrentArea(null);
                    await this.connection.clean();
                    return;
                }
                const replayRegions = (room.missionRegions ?? []).map((r) => ({
                    region_id: r.regionId,
                    type: r.type,
                    params: r.params,
                }));
                this.log.info(`Starting saved-mission clean: favorite_id=${room.favoriteId} on pmap ${pmapId}` +
                    (replayRegions.length > 0 ? ` with ${replayRegions.length} region(s)` : ''));
                this.setCurrentArea(areaId);
                await this.connection.cleanRoomByFavorite(pmapId, userPmapvId, room.favoriteId, replayRegions);
                return;
            }
            // missionRegionIds path: a named multi-room preset specified as a list of
            // region IDs. All regions are included in one cleanRoom call.
            if (room?.missionRegionIds && room.missionRegionIds.length > 0) {
                for (const rid of room.missionRegionIds) {
                    regions.push({ region_id: rid, type: room.regionType ?? 'rid' });
                }
                selectedMapIds.add(room.mapId);
                continue;
            }
            if (!room || !room.regionId) {
                unmappedAreas.push(areaId);
                continue;
            }
            regions.push({ region_id: room.regionId, type: room.regionType ?? 'rid' });
            selectedMapIds.add(room.mapId);
        }
        if (unmappedAreas.length > 0) {
            this.log.warn(`selectAreas referenced Matter areaId(s) [${unmappedAreas.join(', ')}] that have no regionId in config — ` +
                `falling back to whole-home clean. Run discovery mode to capture regionIds and add them to rooms[].`);
            this.setCurrentArea(null);
            await this.connection.clean();
            return;
        }
        // Cross-map check (multi-floor j9+/s9+): if the user picked rooms spanning
        // two maps we can't satisfy both in one mission. Clean only the map the
        // first selected room is on and log the skip.
        if (selectedMapIds.size > 1) {
            const firstMapId = this.rooms.find((r) => r.areaId === this.selectedAreas[0])?.mapId;
            this.log.warn(`selectAreas spans multiple maps ${Array.from(selectedMapIds).join(', ')}; ` +
                `only cleaning rooms on map ${firstMapId}. Move the robot to each map for the remaining rooms separately.`);
            // Filter regions down to the first map's rooms.
            const filteredRegions = this.selectedAreas
                .map((id) => this.rooms.find((r) => r.areaId === id))
                .filter((r) => !!r && r.mapId === firstMapId && !!r.regionId)
                .map((r) => ({ region_id: r.regionId, type: r.regionType ?? 'rid' }));
            regions.length = 0;
            regions.push(...filteredRegions);
        }
        // Pick the pmapId/userPmapvId for this mission. Look up from the `maps`
        // array if configured; else fall back to the device-level defaults.
        const missionMapId = this.rooms.find((r) => r.areaId === this.selectedAreas[0])?.mapId;
        const activeMap = missionMapId !== undefined ? this.maps.find((m) => m.mapId === missionMapId) : undefined;
        const missionPmapId = activeMap?.pmapId ?? this.pmapId;
        const missionUserPmapvId = activeMap?.userPmapvId ?? this.userPmapvId;
        if (!missionPmapId) {
            this.log.warn(`selectAreas requested but no pmapId configured for ${this.deviceName} — falling back to whole-home clean. ` +
                `Add the discovered pmapId/userPmapvId to your device config (or to the \`maps\` entry for multi-floor setups).`);
            this.setCurrentArea(null);
            await this.connection.clean();
            return;
        }
        this.log.info(`Starting room-targeted clean on pmap ${missionPmapId} for ${regions.length} region(s): ` +
            `${regions.map((r) => r.region_id).join(', ')}`);
        // Snapshot the mission baseline. We cycle currentArea using sqft cleaned
        // (preferred: pauses with the robot during recharge/stuck events) and fall
        // back to wall-clock elapsed when sqft isn't increasing.
        const startStatus = this.connection.getStatus();
        this.missionStartMs = Date.now();
        this.missionStartSqft = startStatus.missionSqft;
        this.missionMaxIndex = 0;
        this.setCurrentArea(this.selectedAreas[0]);
        await this.connection.cleanRoom(missionPmapId, missionUserPmapvId, regions);
    }
    /**
     * While a multi-room mission is in progress, compute which area the robot is
     * likely cleaning right now and update `currentArea`. Prefers `sqft` progress
     * (Roomba's own cumulative-cleaned measure, pauses during recharge) over
     * wall-clock elapsed time. Fallback kicks in for firmware that doesn't emit
     * `sqft` or when sqft hasn't incremented yet.
     */
    advanceCurrentAreaFromProgress(status) {
        if (this.selectedAreas.length <= 1)
            return;
        const totalRooms = this.selectedAreas.length;
        let indexRaw;
        let signal;
        const sqftDelta = Math.max(0, status.missionSqft - (this.missionStartSqft ?? 0));
        if (sqftDelta > 0) {
            // sqft-driven: advance every `roomCleanSqft` of cleaned area.
            indexRaw = Math.floor(sqftDelta / this.roomCleanSqft);
            signal = `sqft=${sqftDelta.toFixed(0)} (threshold ${this.roomCleanSqft}/room)`;
        }
        else if (this.missionStartMs !== undefined) {
            // Time-driven fallback.
            const elapsedMs = Date.now() - this.missionStartMs;
            indexRaw = Math.floor(elapsedMs / this.roomCleanDurationMs);
            signal = `elapsed=${Math.round(elapsedMs / 60000)}min`;
        }
        else {
            return;
        }
        // Ratchet: never regress past the highest index we've reached this mission.
        // Skip commands (handled separately) bump missionMaxIndex directly; the
        // time-based estimate below it is just a safety net that catches up if no
        // skip was issued.
        const index = Math.min(Math.max(indexRaw, this.missionMaxIndex), totalRooms - 1);
        if (index > this.missionMaxIndex)
            this.missionMaxIndex = index;
        const targetArea = this.selectedAreas[index];
        if (targetArea !== this.lastPushed.currentArea) {
            this.log.info(`Advancing currentArea to ${targetArea} (room ${index + 1}/${totalRooms}, ${signal})`);
            this.setCurrentArea(targetArea);
        }
    }
    /**
     * Write the ServiceArea.currentArea attribute. Guarded against errors because
     * some controllers don't include the attribute on all feature sets.
     */
    setCurrentArea(areaId) {
        if (!this.endpointActive) {
            this.lastPushed.currentArea = areaId;
            return;
        }
        if (areaId === this.lastPushed.currentArea)
            return;
        try {
            this.device.setAttribute('serviceArea', 'currentArea', areaId, this.log);
            this.lastPushed.currentArea = areaId;
        }
        catch (err) {
            this.log.debug(`Failed to set currentArea=${areaId}: ${err}`);
        }
    }
    listenForStateUpdates() {
        this.connection.on('stateUpdate', (status) => {
            this.updateMatterState(status);
        });
        // User pressed "skip room" on the iRobot app — immediately advance currentArea
        // past the skipped region if it matches one we're tracking. This is the most
        // reliable real-time signal for per-region transitions; time-based cycling is
        // only a fallback when no skip is observed.
        this.connection.on('regionsSkipped', (skippedRegionIds) => {
            this.handleRegionsSkipped(skippedRegionIds);
        });
    }
    /**
     * When the iRobot app fires a skip for a region, advance `currentArea` to the
     * next selected area after the skipped one. If the skipped region isn't in
     * `selectedAreas` at all, it was an iRobot-app-initiated clean outside of
     * Matter's selection — leave state alone.
     */
    handleRegionsSkipped(skippedRegionIds) {
        if (this.selectedAreas.length <= 1)
            return;
        for (const regionId of skippedRegionIds) {
            const room = this.rooms.find((r) => r.regionId === regionId);
            if (!room)
                continue;
            const skippedIdx = this.selectedAreas.indexOf(room.areaId);
            if (skippedIdx === -1)
                continue;
            // Advance to the next selected area after the skipped one (clamped).
            const nextIdx = Math.min(skippedIdx + 1, this.selectedAreas.length - 1);
            // Bump the mission-max ratchet BEFORE writing currentArea so the time-based
            // advance on the same state-update cycle can't regress us back to the skipped
            // room a millisecond later.
            if (nextIdx > this.missionMaxIndex)
                this.missionMaxIndex = nextIdx;
            const nextArea = this.selectedAreas[nextIdx];
            if (nextArea !== this.lastPushed.currentArea) {
                this.log.info(`Region ${regionId} skipped; advancing currentArea to ${nextArea} (room ${nextIdx + 1}/${this.selectedAreas.length})`);
                this.setCurrentArea(nextArea);
            }
        }
    }
    /**
     * Mark the underlying Matter endpoint as ready to accept attribute writes.
     * Should be called from the platform's onConfigure() once the server is online.
     */
    markActive() {
        this.endpointActive = true;
    }
    /**
     * Flip the `reachable` attribute on BridgedDeviceBasicInformation. Apple Home
     * reads this to display "No Response" on an accessory tile when the robot is
     * unreachable; matter.js auto-fires the `ReachableChanged` event when the
     * attribute transitions. Safe to call before `markActive()` — we skip the
     * write silently in that case, avoiding the "endpoint inactive" error spam.
     */
    setReachable(reachable) {
        if (!this.endpointActive)
            return;
        try {
            this.device.setAttribute('bridgedDeviceBasicInformation', 'reachable', reachable, this.log);
        }
        catch (err) {
            this.log.debug(`setReachable(${reachable}) failed: ${err}`);
        }
    }
    /**
     * Cache of last-pushed attribute values so we only call setAttribute when something
     * actually changed. Roomba state messages arrive every ~2s during active cleaning,
     * and matterbridge logs every setAttribute — without a diff here, the log gets
     * spammed with "from X to X" noise.
     */
    lastPushed = {};
    /** Tracks whether the robot was running on the previous state update so we can detect the running→idle transition. */
    wasActive = false;
    /**
     * Mission-level state carried across state updates so we can synthesize a
     * single `OperationCompletion` event at the running→idle edge with the total
     * elapsed time. Matter 1.4 §7.5.7.2 — this event lets Apple Home (iOS 18.4+)
     * push a "cleaning finished" notification to the user's phone.
     */
    missionActive = false;
    missionStartTs = 0;
    missionLastError = 0;
    /**
     * True once we've seen `tankLevel > 0` at least once — proves the robot has a
     * water tank installed. Without this, we'd spuriously report "Water Tank Empty"
     * for every vacuum-only model (whose tankLvl just never gets set).
     */
    robotHasSeenTank = false;
    /**
     * Push current Roomba state to the Matter device attributes, skipping writes whose
     * value hasn't changed since the previous push.
     */
    updateMatterState(status) {
        if (!this.endpointActive)
            return;
        try {
            const runMode = statusToRunMode(status);
            if (runMode !== this.lastPushed.runMode) {
                this.device.setAttribute('rvcRunMode', 'currentMode', runMode, this.log);
                this.lastPushed.runMode = runMode;
            }
            const opState = statusToOperationalState(status);
            if (opState !== this.lastPushed.opState) {
                this.device.setAttribute('rvcOperationalState', 'operationalState', opState, this.log);
                this.lastPushed.opState = opState;
            }
            // Roomba reports bin-full and tank-empty as separate booleans from the
            // numeric errorCode — fold both into the error struct so Apple Home / HA
            // can surface them via the standard RvcOperationalState error notification.
            const errorState = errorCodeToMatterError(status.errorCode, {
                binFull: status.binFull,
                // Only treat tankLvl=0 as "tank empty" on models that have a tank at all
                // (mop-equipped). tankLevel > 0 at least once in a mission proves it.
                tankEmpty: this.robotHasSeenTank && status.tankLevel === 0,
            });
            if (status.tankLevel > 0)
                this.robotHasSeenTank = true;
            if (errorState.errorStateId !== this.lastPushed.errorStateId) {
                this.device.setAttribute('rvcOperationalState', 'operationalError', errorState, this.log);
                // Also fire the Matter event so event-based subscribers (Apple Home
                // notifications, HA automations) get a push for the transition.
                if (errorState.errorStateId !== RvcOperationalState.ErrorState.NoError) {
                    this.device
                        .triggerEvent('rvcOperationalState', 'operationalError', errorState, this.log)
                        .catch((err) => this.log.debug(`triggerEvent operationalError failed: ${err}`));
                    this.log.info(`Robot error transition: id=${errorState.errorStateId} (Roomba errorCode=${status.errorCode}, binFull=${status.binFull}, tankLevel=${status.tankLevel})`);
                }
                this.lastPushed.errorStateId = errorState.errorStateId;
            }
            // Matter spec: batPercentRemaining is 0-200, representing 0-100% in 0.5% steps
            const batteryPct = Math.min(status.batteryLevel * 2, 200);
            if (batteryPct !== this.lastPushed.batteryPct) {
                this.device.setAttribute('powerSource', 'batPercentRemaining', batteryPct, this.log);
                this.lastPushed.batteryPct = batteryPct;
            }
            const chargeLevel = batteryToChargeLevel(status.batteryLevel);
            if (chargeLevel !== this.lastPushed.batChargeLevel) {
                this.device.setAttribute('powerSource', 'batChargeLevel', chargeLevel, this.log);
                this.lastPushed.batChargeLevel = chargeLevel;
            }
            // Charge state: 0 = Unknown, 1 = IsCharging, 2 = IsAtFullCharge, 3 = IsNotCharging
            let chargeState = 3;
            if (status.charging) {
                chargeState = status.batteryLevel >= 100 ? 2 : 1;
            }
            if (chargeState !== this.lastPushed.batChargeState) {
                this.device.setAttribute('powerSource', 'batChargeState', chargeState, this.log);
                this.lastPushed.batChargeState = chargeState;
            }
            // ServiceArea.currentArea / selectedAreas lifecycle. ONLY act on the
            // running→idle transition, not on every poll while docked — otherwise we
            // race against Apple Home's `selectAreas` (which arrives before `changeToMode`
            // while the robot is still docked) and clear the selection out from under it,
            // causing the mission to fall back to a whole-home clean.
            const isActive = status.running || status.paused;
            // Mission lifecycle tracking — used for OperationCompletion event firing
            // at the running→idle transition. We want the ELAPSED time of the whole
            // mission, not just the current running stretch, so start the timer on
            // the first running edge and only reset at mission end.
            if (!this.missionActive && status.running) {
                this.missionActive = true;
                this.missionStartTs = Date.now();
                this.missionLastError = 0;
            }
            if (this.missionActive && status.errorCode !== 0) {
                // Latch any error we see during the mission — the final state might
                // clear errorCode to 0 before we emit the completion event, but users
                // still want to know "why" the mission ended.
                this.missionLastError = status.errorCode;
            }
            if (this.wasActive && !isActive) {
                // Fire the Matter OperationCompletion event with the total mission time
                // and the final error state. Apple Home (iOS 18.4+) consumes this to
                // push a "cleaning finished" notification. Fired exactly once per
                // mission, at the running→idle edge.
                if (this.missionActive) {
                    const totalOperationalTime = Math.round((Date.now() - this.missionStartTs) / 1000);
                    const completionErrorCode = errorCodeToMatterError(this.missionLastError, { binFull: status.binFull }).errorStateId;
                    this.device
                        .triggerEvent('rvcOperationalState', 'operationCompletion', {
                        completionErrorCode,
                        totalOperationalTime,
                        pausedTime: null,
                    }, this.log)
                        .catch((err) => this.log.debug(`triggerEvent operationCompletion failed: ${err}`));
                    this.log.info(`Mission completed: errorCode=${completionErrorCode} totalOperationalTime=${totalOperationalTime}s`);
                    this.missionActive = false;
                    this.missionLastError = 0;
                }
                if (this.lastPushed.currentArea !== null) {
                    this.setCurrentArea(null);
                }
                // Don't clear `selectedAreas` on mission end — Apple Home re-sends
                // `selectAreas` before every subsequent mission so there's no risk of
                // stale selections carrying over. AND clearing triggers the iPhone
                // Home UI regression where empty SelectedAreas renders as "first room
                // ticked" instead of "all rooms". Leaving the attribute alone means
                // the room picker keeps displaying the user's last selection between
                // runs, which is also slightly better UX.
                this.missionStartMs = undefined;
                this.missionStartSqft = undefined;
            }
            else if (status.running && this.selectedAreas.length > 1) {
                // During an active multi-room mission, advance `currentArea` on each state
                // update so Apple Home's UI progresses from room to room instead of being
                // stuck on the first one. Driven by the robot's cumulative sqft cleaned
                // (or elapsed time when sqft isn't emitted).
                this.advanceCurrentAreaFromProgress(status);
            }
            this.wasActive = isActive;
        }
        catch (err) {
            this.log.debug(`Error updating Matter state: ${err}`);
        }
    }
    /**
     * Set initial device state on configure.
     */
    initializeState() {
        const status = this.connection.getStatus();
        this.updateMatterState(status);
    }
}
/**
 * Translate a Matter `RvcCleanMode` id to a Roomba cleaning preset. Returns
 * `null` for modes that don't correspond to a vacuum-power preset (e.g. Mop
 * modes — the Roomba picks suction automatically based on the installed tool).
 */
function matterModeToPreset(mode) {
    switch (mode) {
        case CLEAN_MODE_VACUUM:
            return 'auto';
        case CLEAN_MODE_QUICK:
            return 'quick';
        case CLEAN_MODE_MAX:
            return 'max';
        case CLEAN_MODE_DEEP_CLEAN:
            return 'deep';
        default:
            return null;
    }
}
/**
 * Roomba reports firmware versions like "lewis+3.20.13.57". Extract the numeric portion
 * and pack it into a 32-bit integer Matter can store (major*10000 + minor*100 + patch).
 */
function parseSoftwareVersion(ver) {
    const match = /(\d+)\.(\d+)\.(\d+)/.exec(ver);
    if (!match)
        return 1;
    const [, major, minor, patch] = match;
    return Number(major) * 10000 + Number(minor) * 100 + Number(patch);
}
function parseHardwareVersion(ver) {
    const match = /(\d+)/.exec(ver);
    return match ? Number(match[1]) : 1;
}
//# sourceMappingURL=roombaDevice.js.map