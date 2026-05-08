/**
 * Roomba connection manager using dorita980 for local MQTT communication.
 */
import { Local } from 'dorita980';
import { EventEmitter } from 'events';
const ROBOT_CIPHERS = ['AES128-SHA256', 'TLS_AES_256_GCM_SHA384'];
const CONNECT_TIMEOUT_MS = 30_000;
export class RoombaConnection extends EventEmitter {
    config;
    log;
    robot = null;
    cipherIndex = 0;
    connected = false;
    connecting = false;
    disconnectEmitted = false;
    latestState = {};
    refreshTimer = null;
    activeRefreshMs;
    idleRefreshMs;
    /** Accumulated map of pmap_id -> discovered rooms, populated while `discoverRooms` is on. */
    discoveredMaps = new Map();
    /** Accumulated map of favorite_id -> discovered missions. */
    discoveredFavorites = new Map();
    constructor(config, log) {
        super();
        this.config = config;
        this.log = log;
        this.activeRefreshMs = (config.refreshInterval ?? 10) * 1000;
        this.idleRefreshMs = (config.idleRefreshInterval ?? 120) * 1000;
    }
    async connect() {
        if (this.connected || this.connecting)
            return;
        this.connecting = true;
        try {
            for (let attempt = 0; attempt < ROBOT_CIPHERS.length; attempt++) {
                const cipher = ROBOT_CIPHERS[this.cipherIndex];
                this.log.debug(`Connecting to Roomba ${this.config.blid} at ${this.config.ipAddress} (cipher: ${cipher})`);
                try {
                    await this.attemptConnect(cipher);
                    this.log.info(`Connected to Roomba ${this.config.blid}`);
                    this.disconnectEmitted = false;
                    return;
                }
                catch (err) {
                    this.log.warn(`Connection failed with cipher ${cipher}: ${err}`);
                    this.teardownRobot();
                    this.cipherIndex = (this.cipherIndex + 1) % ROBOT_CIPHERS.length;
                }
            }
            throw new Error(`Failed to connect to Roomba ${this.config.blid} after trying all ciphers`);
        }
        finally {
            this.connecting = false;
        }
    }
    attemptConnect(cipher) {
        return new Promise((resolve, reject) => {
            let settled = false;
            const timeout = setTimeout(() => {
                if (settled)
                    return;
                settled = true;
                reject(new Error('Connection timed out'));
            }, CONNECT_TIMEOUT_MS);
            try {
                this.robot = new Local(this.config.blid, this.config.password, this.config.ipAddress, 2, {
                    ciphers: cipher,
                });
                this.robot.on('connect', () => {
                    if (settled)
                        return;
                    settled = true;
                    clearTimeout(timeout);
                    this.connected = true;
                    this.startPolling();
                    resolve();
                });
                this.robot.on('state', (state) => {
                    this.mergeState(state);
                    if (this.config.verboseState)
                        this.logStateDelta(state);
                    this.emit('stateUpdate', this.getStatus());
                });
                this.robot.on('close', () => {
                    if (!settled) {
                        settled = true;
                        clearTimeout(timeout);
                        reject(new Error('Connection closed before established'));
                        return;
                    }
                    this.handleDisconnect('close');
                });
                this.robot.on('offline', () => {
                    if (!settled) {
                        settled = true;
                        clearTimeout(timeout);
                        reject(new Error('Robot offline during connect'));
                        return;
                    }
                    this.log.warn(`Roomba ${this.config.blid} went offline`);
                    this.handleDisconnect('offline');
                });
                this.robot.on('error', (...args) => {
                    const err = args[0] instanceof Error ? args[0] : new Error(String(args[0]));
                    if (!settled) {
                        settled = true;
                        clearTimeout(timeout);
                        reject(err);
                    }
                });
            }
            catch (err) {
                if (!settled) {
                    settled = true;
                    clearTimeout(timeout);
                    reject(err instanceof Error ? err : new Error(String(err)));
                }
            }
        });
    }
    handleDisconnect(reason) {
        this.connected = false;
        this.stopPolling();
        this.teardownRobot();
        if (!this.disconnectEmitted) {
            this.disconnectEmitted = true;
            this.log.debug(`Roomba ${this.config.blid} disconnect emitted (reason: ${reason})`);
            this.emit('disconnected');
        }
    }
    teardownRobot() {
        if (!this.robot)
            return;
        try {
            this.robot.removeAllListeners();
        }
        catch {
            // ignore
        }
        try {
            this.robot.end();
        }
        catch {
            // ignore
        }
        this.robot = null;
    }
    mergeState(state) {
        Object.assign(this.latestState, state);
        this.captureDiscovery(state);
        this.captureSkipCommand(state);
    }
    lastSeenCommandTime;
    /** Tracks the most recent skip command we emitted, so we don't re-emit on state heartbeats. */
    lastSkipCommandTime;
    /**
     * Detect when the user (or anyone) pressed the "skip room" button on the iRobot
     * app. This is the ONE real-time per-region signal Roomba firmware exposes —
     * `sqft`/`mssnM` stay at 0 on j5+/j7+ so time-based cycling is the only
     * automatic fallback, but skips let us advance currentArea precisely when a
     * human actually moves the robot past a room.
     */
    captureSkipCommand(state) {
        const lc = state.lastCommand;
        if (!lc || lc.command !== 'skip')
            return;
        if (!Array.isArray(lc.regions) || lc.regions.length === 0)
            return;
        // lastCommand.time is a seconds-since-epoch timestamp of when the command ran.
        // Use it to dedup across repeated state heartbeats that echo the same command.
        if (lc.time === this.lastSkipCommandTime)
            return;
        this.lastSkipCommandTime = lc.time;
        this.emit('regionsSkipped', lc.regions.map((r) => r.region_id));
    }
    /**
     * If a `lastCommand` has just arrived, capture room and/or mission discovery data.
     *
     * Branch 1 — region discovery: merge region IDs into the discovered map catalog
     * and emit `roomsInMission` / `roomsDiscovered` so listeners can correlate IDs
     * with the room just cleaned in the iRobot app.
     *
     * Branch 2 — favorite discovery: capture `favorite_id` + full region payload
     * (including per-region params) so the mission can be replayed exactly later.
     * Favorites often include regions too, so both branches fire on the same command.
     */
    captureDiscovery(state) {
        const lc = state.lastCommand;
        if (!lc || !lc.pmap_id)
            return;
        // Only fire once per distinct mission (lastCommand.time is the mission timestamp).
        if (lc.time && lc.time === this.lastSeenCommandTime)
            return;
        this.lastSeenCommandTime = lc.time;
        const hasRegions = Array.isArray(lc.regions) && lc.regions.length > 0;
        // Branch 1: region-based room discovery.
        if (hasRegions) {
            const existing = this.discoveredMaps.get(lc.pmap_id) ?? {
                pmapId: lc.pmap_id,
                userPmapvId: lc.user_pmapv_id,
                regions: [],
            };
            if (lc.user_pmapv_id)
                existing.userPmapvId = lc.user_pmapv_id;
            const newRegionIds = [];
            for (const region of lc.regions) {
                if (!region || !region.region_id)
                    continue;
                if (existing.regions.some((r) => r.regionId === region.region_id))
                    continue;
                existing.regions.push({
                    regionId: region.region_id,
                    type: region.type ?? 'rid',
                    firstSeen: Date.now(),
                });
                newRegionIds.push(region.region_id);
            }
            this.discoveredMaps.set(lc.pmap_id, existing);
            // Per-mission event: tell listeners what was in THIS command (regardless of
            // whether it's new or a repeat). This is what makes "clean one room, see its id"
            // work as an identification strategy.
            this.emit('roomsInMission', {
                pmapId: lc.pmap_id,
                userPmapvId: lc.user_pmapv_id,
                command: lc.command,
                selectAll: lc.select_all ?? false,
                regions: lc.regions.map((r) => ({
                    regionId: r.region_id,
                    type: r.type ?? 'rid',
                    params: r.params,
                })),
                newRegionIds,
                time: lc.time,
                favoriteId: lc.favorite_id,
            });
            if (newRegionIds.length > 0) {
                this.emit('roomsDiscovered', Array.from(this.discoveredMaps.values()));
            }
        }
        // Branch 2: favorite/mission discovery. Capture the full payload so it can
        // be replayed exactly (preserving per-region params like twoPass, carpetBoost).
        if (lc.favorite_id) {
            const isNew = !this.discoveredFavorites.has(lc.favorite_id);
            this.log.info(`${isNew ? 'Captured' : 'Updated'} saved mission: favorite_id=${lc.favorite_id} ` +
                `pmap=${lc.pmap_id} regions=${(lc.regions ?? []).length}. ` +
                `Total cached: ${this.discoveredFavorites.size + (isNew ? 1 : 0)}.`);
            this.discoveredFavorites.set(lc.favorite_id, {
                favoriteId: lc.favorite_id,
                pmapId: lc.pmap_id,
                userPmapvId: lc.user_pmapv_id,
                regions: (lc.regions ?? []).map((r) => ({
                    regionId: r.region_id,
                    type: r.type ?? 'rid',
                    params: r.params,
                })),
            });
            // Emit roomsInMission for the favorite-only case (no regions in command).
            if (!hasRegions) {
                this.emit('roomsInMission', {
                    pmapId: lc.pmap_id,
                    userPmapvId: lc.user_pmapv_id,
                    command: lc.command,
                    selectAll: false,
                    regions: [],
                    newRegionIds: [],
                    time: lc.time,
                    favoriteId: lc.favorite_id,
                });
            }
        }
    }
    /** Returns the current discovery catalog (may be empty). */
    getDiscoveredMaps() {
        return Array.from(this.discoveredMaps.values());
    }
    /** Returns all favorites/missions captured from lastCommand (may be empty). */
    getDiscoveredFavorites() {
        return Array.from(this.discoveredFavorites.values());
    }
    /** Signature of the last mission/command/pose/bbmssn slice we logged, for dedup. */
    lastVerboseSignatures = {};
    /**
     * Emit compact one-line log entries for the bits of robot state we care about,
     * but ONLY when they've changed since the last log. Robot sends heartbeat state
     * messages every ~2s; without this dedup the log gets spammed with identical lines.
     */
    logStateDelta(state) {
        if (state.cleanMissionStatus) {
            const cms = state.cleanMissionStatus;
            const sig = `${cms.cycle}|${cms.phase}|${cms.mssnM}|${cms.sqft ?? ''}|${cms.error}|${cms.nMssn}|${cms.notReady}`;
            if (sig !== this.lastVerboseSignatures.mission) {
                this.lastVerboseSignatures.mission = sig;
                this.log.info(`[mission] cycle=${cms.cycle} phase=${cms.phase} mssnM=${cms.mssnM} ` +
                    `sqft=${cms.sqft ?? '-'} err=${cms.error} nMssn=${cms.nMssn} notReady=${cms.notReady}`);
            }
        }
        const lc = state.lastCommand;
        if (lc) {
            const regionList = lc.regions?.map((r) => r.region_id).join(',') ?? '-';
            const sig = `${lc.command}|${lc.initiator}|${lc.time}|${lc.pmap_id ?? ''}|${regionList}|${lc.ordered}`;
            if (sig !== this.lastVerboseSignatures.lastCommand) {
                this.lastVerboseSignatures.lastCommand = sig;
                this.log.info(`[lastCommand] command=${lc.command} initiator=${lc.initiator} time=${lc.time} ` +
                    `pmap_id=${lc.pmap_id ?? '-'} regions=[${regionList}] ordered=${lc.ordered}`);
            }
        }
        const pose = state.pose;
        if (pose?.point) {
            // Round pose to integer so every millimetre of robot movement doesn't spam the log.
            const sig = `${Math.round(pose.point.x)}|${Math.round(pose.point.y)}|${Math.round(pose.theta ?? 0)}`;
            if (sig !== this.lastVerboseSignatures.pose) {
                this.lastVerboseSignatures.pose = sig;
                this.log.info(`[pose] x=${pose.point.x} y=${pose.point.y} theta=${pose.theta}`);
            }
        }
        const bb = state.bbmssn;
        if (bb?.aMssnM !== undefined) {
            const sig = `${bb.aMssnM}|${bb.nMssnC}`;
            if (sig !== this.lastVerboseSignatures.bbmssn) {
                this.lastVerboseSignatures.bbmssn = sig;
                this.log.info(`[bbmssn] aMssnM=${bb.aMssnM} nMssnC=${bb.nMssnC}`);
            }
        }
        // Capabilities + installed-tool fields. Only log once per connection when
        // they appear; they're static per robot/tool-swap and noisy otherwise.
        const capFields = [
            ['sku', state.sku],
            ['cap', state.cap],
            ['tankLvl', state.tankLvl],
            ['bin', state.bin],
            ['mopReady', state.mopReady],
            ['detectedPad', state.detectedPad],
            ['padWetness', state.padWetness],
            ['subModSwVer', state.subModSwVer],
        ];
        for (const [name, val] of capFields) {
            if (val === undefined)
                continue;
            const sigKey = `cap:${name}`;
            const sig = JSON.stringify(val);
            if (sig !== this.lastVerboseSignatures[sigKey]) {
                this.lastVerboseSignatures[sigKey] = sig;
                this.log.info(`[${name}] ${sig}`);
            }
        }
    }
    getInfo() {
        const s = this.latestState;
        const cap = s.cap ?? {};
        const asNum = (v) => (typeof v === 'number' ? v : 0);
        return {
            name: s.name ?? this.config.name ?? `Roomba ${this.config.blid}`,
            sku: s.sku ?? this.config.model ?? 'Roomba',
            softwareVer: s.softwareVer ?? 'unknown',
            hardwareVer: s.hardwareVer ?? 'unknown',
            capabilities: {
                multiPass: asNum(cap.multiPass) >= 1,
                // Carpet-boost / power-pass indicator varies across firmware generations:
                //   - 980 / i7 era exposed `cap.carpetBoost` explicitly.
                //   - 980 also uses `cap.pp` (power-pass) for the same thing.
                //   - j-series drops the explicit flag but publishes
                //     `cap.floorTypeDetect` (the sensor that drives auto-boost), which
                //     any robot with carpet-boost support also has.
                // Accept any of the three so we don't under-report Max/DeepClean on
                // newer models that implicitly support them.
                carpetBoost: asNum(cap.carpetBoost) >= 1 ||
                    asNum(cap.pp) >= 1 ||
                    asNum(cap.floorTypeDetect) >= 1,
            },
        };
    }
    /**
     * Classify the robot into a cleaning-mode family based on its SKU. This drives
     * which Matter `RvcCleanMode` options the plugin advertises at startup.
     *
     * Roomba SKUs follow the pattern `<letter><digits><modifiers>`:
     *   - j5*, j6*, i7+ (pre-Combo): bin standard, mop reservoir is a sold-separately swap.
     *   - j7/j9 with "Combo" marker: integrated bin+tank, auto-switches per surface.
     *   - m6, m8 (Braava): mop-only.
     *   - i1-i4, 600/700/800/900 series, s9: vacuum-only.
     *
     * The Combo identifier isn't in SKU — iRobot uses model suffixes like "J7 Combo".
     * The cloud API returns distinct SKUs for Combo units (e.g. `j755040`) but the
     * difference from a non-Combo `j755020` isn't published. Fall back to checking
     * whether live state ever reports `tankLvl` or `mopReady` — if yes, treat as combo.
     */
    classifyFamily() {
        const sku = (this.latestState.sku ?? this.config.model ?? '').toString();
        const head = sku.slice(0, 1).toLowerCase();
        if (head === 'm')
            return 'mop';
        // Combo detection: live state has revealed tank/mop fields → treat as combo.
        // This covers j7/j9 Combo, s9+ Combo, and future combo units regardless of SKU.
        if (this.latestState.tankLvl !== undefined || this.latestState.mopReady !== undefined) {
            return 'combo';
        }
        // j/i series: swappable models ship with a swappable bin + optional mop cartridge.
        // j1-j6 pre-Combo are classic swappable; j7/j9 non-Combo are rare but possible.
        if ((head === 'j' || head === 'i') && /^[ji][1-6]/.test(sku)) {
            return 'swappable';
        }
        // Older vacuum-only models (600-900) and s-series, plus i1-i4.
        if (head === 's' || /^\d{3}/.test(sku) || (head === 'i' && /^i[1-4]/.test(sku))) {
            return 'vacuum';
        }
        // Newer j7/j9 default to combo-ish to surface options; runtime gating still
        // applies. Unknown SKUs fall back to vacuum-only to avoid false mop promises.
        if (head === 'j')
            return 'combo';
        return 'unknown';
    }
    /**
     * Read current tool installation from MQTT state. Used to gate which modes
     * are *currently* available on swappable models (owner physically swapped to
     * the mop reservoir) and to detect pad faults on combo units.
     */
    getInstalledTool() {
        const s = this.latestState;
        const binInstalled = s.bin?.present !== false; // missing field defaults to "present"
        const mopInstalled = (typeof s.tankLvl === 'number' && s.tankLvl >= 0 && s.bin?.present === false) ||
            s.mopReady?.tankPresent === true ||
            (s.detectedPad !== undefined && s.detectedPad !== 'invalid');
        const padFaulted = s.detectedPad === 'invalid';
        return { binInstalled, mopInstalled, padFaulted };
    }
    getStatus() {
        const s = this.latestState;
        const phase = s.cleanMissionStatus?.phase ?? 'charge';
        const cycle = s.cleanMissionStatus?.cycle ?? 'none';
        const errorCode = s.cleanMissionStatus?.error ?? 0;
        const running = phase === 'run';
        const charging = phase === 'charge' || phase === 'recharge';
        const docking = phase === 'hmUsrDock' || phase === 'hmMidMsn' || phase === 'hmPostMsn';
        const paused = !running && cycle === 'clean' && phase === 'stop';
        const stuck = phase === 'stuck';
        return {
            running,
            charging,
            docking,
            paused,
            stuck,
            batteryLevel: s.batPct ?? 0,
            binFull: s.bin?.full ?? false,
            tankLevel: s.tankLvl ?? 0,
            phase,
            errorCode,
            cycle,
            name: s.name ?? this.config.name ?? `Roomba ${this.config.blid}`,
            missionSqft: s.cleanMissionStatus?.sqft ?? 0,
            missionElapsedMin: s.cleanMissionStatus?.mssnM ?? 0,
            avgMissionMin: s.bbmssn?.aMssnM ?? 0,
            installedTool: this.getInstalledTool(),
        };
    }
    startPolling() {
        this.stopPolling();
        const status = this.getStatus();
        const interval = status.running || status.docking ? this.activeRefreshMs : this.idleRefreshMs;
        this.refreshTimer = setInterval(() => {
            this.refreshState();
        }, interval);
    }
    stopPolling() {
        if (this.refreshTimer) {
            clearInterval(this.refreshTimer);
            this.refreshTimer = null;
        }
    }
    async refreshState() {
        if (!this.robot || !this.connected)
            return;
        try {
            const state = await this.robot.getRobotState(['batPct', 'bin', 'cleanMissionStatus', 'tankLvl']);
            this.mergeState(state);
            this.emit('stateUpdate', this.getStatus());
            // Adjust polling rate based on activity
            const status = this.getStatus();
            const desiredInterval = status.running || status.docking ? this.activeRefreshMs : this.idleRefreshMs;
            if (this.refreshTimer) {
                this.stopPolling();
                this.refreshTimer = setInterval(() => this.refreshState(), desiredInterval);
            }
        }
        catch (err) {
            this.log.debug(`Failed to refresh state for ${this.config.blid}: ${err}`);
        }
    }
    /**
     * Wait briefly for at least one MQTT state message from the robot, then return whatever
     * identifying fields we've accumulated. Unlike `getRobotState`, this does NOT block until
     * every requested field has been seen — some fields (e.g. `hardwareVer`) may never arrive
     * from newer models, so we take a best-effort snapshot instead.
     */
    async fetchIdentity(timeoutMs = 5_000) {
        if (!this.connected) {
            throw new Error('Not connected');
        }
        if (this.latestState.sku || this.latestState.softwareVer) {
            return this.getInfo();
        }
        await new Promise((resolve) => {
            const timer = setTimeout(resolve, timeoutMs);
            const once = () => {
                clearTimeout(timer);
                resolve();
            };
            this.once('stateUpdate', once);
        });
        return this.getInfo();
    }
    async clean() {
        if (!this.robot)
            throw new Error('Not connected');
        await this.robot.clean();
    }
    /** Start a mapping / training run (Roomba explores and refines its pmap). */
    async train() {
        if (!this.robot)
            throw new Error('Not connected');
        await this.robot.train();
    }
    /**
     * Apply a pair of cleaning-power preferences (carpet boost + passes). Used
     * when the controller picks a `RvcCleanMode` like Auto / Quick / Max /
     * DeepClean — each of these presets corresponds to a specific combination.
     * The robot stores these persistently; subsequent `clean()`/`cleanRoom()`
     * commands use whatever preset was last applied.
     */
    async applyCleaningPreset(preset) {
        if (!this.robot)
            throw new Error('Not connected');
        switch (preset) {
            case 'auto':
                await this.robot.setCarpetBoostAuto();
                await this.robot.setCleaningPassesAuto();
                return;
            case 'quick':
                // Eco carpet boost + single pass = fast, quiet, light clean.
                await this.robot.setCarpetBoostEco();
                await this.robot.setCleaningPassesOne();
                return;
            case 'max':
                // Performance boost + auto passes = high suction, smart pass count.
                await this.robot.setCarpetBoostPerformance();
                await this.robot.setCleaningPassesAuto();
                return;
            case 'deep':
                // Performance boost + two passes = thorough double-cover.
                await this.robot.setCarpetBoostPerformance();
                await this.robot.setCleaningPassesTwo();
                return;
        }
    }
    /**
     * Start a room-targeted clean. `regions` must contain one or more
     * `{ region_id, type }` pairs — the robot rejects the command if any region is
     * not present in its active pmap. `pmapId` + `userPmapvId` identify which map
     * version those regions belong to.
     */
    async cleanRoom(pmapId, userPmapvId, regions) {
        if (!this.robot)
            throw new Error('Not connected');
        if (regions.length === 0) {
            throw new Error('cleanRoom called with no regions; falling back to full clean is the caller\u2019s responsibility');
        }
        await this.robot.cleanRoom({
            ordered: 1,
            pmap_id: pmapId,
            user_pmapv_id: userPmapvId,
            regions,
        });
    }
    /**
     * Dispatch a saved Roomba mission by `favorite_id`, replaying the full region
     * payload (including per-region params) exactly as captured from `lastCommand`.
     */
    async cleanRoomByFavorite(pmapId, userPmapvId, favoriteId, regions) {
        if (!this.robot)
            throw new Error('Not connected');
        await this.robot.cleanRoom({
            ordered: 0,
            pmap_id: pmapId,
            user_pmapv_id: userPmapvId,
            favorite_id: favoriteId,
            regions,
        });
    }
    async pause() {
        if (!this.robot)
            throw new Error('Not connected');
        await this.robot.pause();
    }
    async resume() {
        if (!this.robot)
            throw new Error('Not connected');
        await this.robot.resume();
    }
    async stop() {
        if (!this.robot)
            throw new Error('Not connected');
        await this.robot.stop();
    }
    async dock() {
        if (!this.robot)
            throw new Error('Not connected');
        await this.robot.dock();
    }
    async find() {
        if (!this.robot)
            throw new Error('Not connected');
        await this.robot.find();
    }
    disconnect() {
        this.stopPolling();
        this.teardownRobot();
        this.connected = false;
        // Intentionally do not emit 'disconnected' on explicit disconnect.
        this.disconnectEmitted = true;
    }
    isConnected() {
        return this.connected;
    }
    getBlid() {
        return this.config.blid;
    }
    getDeviceName() {
        return this.config.name ?? `Roomba ${this.config.blid}`;
    }
}
//# sourceMappingURL=roombaConnection.js.map