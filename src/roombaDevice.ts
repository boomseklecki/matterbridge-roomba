/**
 * Roomba vacuum cleaner device for Matterbridge.
 * Wraps the RoboticVacuumCleaner base class and handles command routing.
 */

import { RoboticVacuumCleaner } from 'matterbridge/devices';
import { RvcRunMode, RvcCleanMode, RvcOperationalState, ServiceArea } from 'matterbridge/matter/clusters';
import type { AnsiLogger } from 'matterbridge/logger';
import type { RoombaConnection, RoombaInfo, RoombaStatus, RoombaRoomConfig } from './roombaConnection.js';
import {
  RUN_MODE_IDLE,
  RUN_MODE_CLEANING,
  RUN_MODE_MAPPING,
  CLEAN_MODE_VACUUM,
  statusToRunMode,
  statusToOperationalState,
  errorCodeToMatterError,
  batteryToChargeLevel,
} from './stateMapping.js';

// Run modes. `Mapping` triggers a training mission where the robot explores the
// floor without actually cleaning — used to build/refine the persistent map.
// Supported on every dorita980-compatible Roomba that has a pmap (j-series, s-series).
const SUPPORTED_RUN_MODES: RvcRunMode.ModeOption[] = [
  { label: 'Idle', mode: RUN_MODE_IDLE, modeTags: [{ value: RvcRunMode.ModeTag.Idle }] },
  { label: 'Cleaning', mode: RUN_MODE_CLEANING, modeTags: [{ value: RvcRunMode.ModeTag.Cleaning }] },
  { label: 'Mapping', mode: RUN_MODE_MAPPING, modeTags: [{ value: RvcRunMode.ModeTag.Mapping }] },
];

// Clean modes: Roomba is vacuum-only (no mop)
const SUPPORTED_CLEAN_MODES: RvcCleanMode.ModeOption[] = [
  { label: 'Vacuum', mode: CLEAN_MODE_VACUUM, modeTags: [{ value: RvcCleanMode.ModeTag.Vacuum }] },
];

// Operational states.
// NOTE: `operationalStateLabel` is only allowed for manufacturer-specific IDs (128-191),
// not for the standard IDs used below — so we omit it.
const SUPPORTED_OP_STATES: RvcOperationalState.OperationalStateStruct[] = [
  { operationalStateId: RvcOperationalState.OperationalState.Stopped },
  { operationalStateId: RvcOperationalState.OperationalState.Running },
  { operationalStateId: RvcOperationalState.OperationalState.Paused },
  { operationalStateId: RvcOperationalState.OperationalState.Error },
  { operationalStateId: RvcOperationalState.OperationalState.SeekingCharger },
  { operationalStateId: RvcOperationalState.OperationalState.Charging },
  { operationalStateId: RvcOperationalState.OperationalState.Docked },
];

/**
 * Matter Area namespace tag values (spec §7.19.12.4.15).
 * Extend as needed — unknown `type` strings fall back to `null` (no area type),
 * which still shows the user-provided name in the controller.
 */
const AREA_TAG_BY_NAME: Record<string, number> = {
  bathroom: 0x06,
  bedroom: 0x07,
  breakfastroom: 0x0a,
  cellar: 0x0c,
  closet: 0x0e,
  dining: 0x15,
  familyroom: 0x1d,
  foyer: 0x1e,
  gameroom: 0x21,
  garage: 0x22,
  guestbathroom: 0x26,
  guestbedroom: 0x27,
  guestroom: 0x29,
  gym: 0x2a,
  hallway: 0x2b,
  kidsroom: 0x2d,
  kitchen: 0x2f,
  laundry: 0x31,
  library: 0x33,
  living: 0x34,
  livingroom: 0x34,
  lounge: 0x35,
  mudroom: 0x36,
  office: 0x38,
  pantry: 0x3b,
  patio: 0x3e,
  playroom: 0x3f,
  primarybathroom: 0x42,
  primarybedroom: 0x43,
  recroom: 0x46,
  recreationroom: 0x46,
  staircase: 0x52,
  storageroom: 0x54,
  study: 0x56,
  sunroom: 0x57,
};

function resolveAreaTypeId(type: string | undefined): number | null {
  if (!type) return null;
  return AREA_TAG_BY_NAME[type.toLowerCase().replace(/[\s_-]/g, '')] ?? null;
}

/**
 * Matter's ServiceArea cluster requires `CurrentArea` to reference a valid id in
 * `SupportedAreas` (or be null — but matterbridge's helper forces a number default).
 * To keep conformance happy when the user hasn't configured any rooms, we expose a single
 * "Everywhere" catch-all area with id 1. This mirrors how the iRobot app treats a
 * whole-home clean when no zones are specified.
 */
const EVERYWHERE_AREA: ServiceArea.Area = {
  areaId: 1,
  mapId: null,
  areaInfo: {
    locationInfo: {
      locationName: 'Everywhere',
      floorNumber: 0,
      areaType: null,
    },
    landmarkInfo: null,
  },
};

function buildSupportedAreas(rooms: RoombaRoomConfig[] | undefined): ServiceArea.Area[] {
  if (!rooms || rooms.length === 0) return [EVERYWHERE_AREA];
  return rooms.map((room) => ({
    areaId: room.areaId,
    mapId: null,
    areaInfo: {
      locationInfo: {
        locationName: room.name,
        floorNumber: room.floor ?? 0,
        areaType: resolveAreaTypeId(room.type),
      },
      landmarkInfo: null,
    },
  }));
}

export class RoombaDevice {
  public readonly device: RoboticVacuumCleaner;
  private endpointActive = false;
  private readonly deviceName: string;
  private readonly serialNumber: string;
  private readonly serverMode: boolean;
  private readonly rooms: RoombaRoomConfig[];
  private readonly pmapId: string | undefined;
  private readonly userPmapvId: string | undefined;
  private readonly roomCleanDurationMs: number;
  private readonly roomCleanSqft: number;
  /** Matter areaIds currently selected by the controller (from `selectAreas`). */
  private selectedAreas: number[] = [];
  /** Wall-clock time the current multi-room mission started; fallback advance signal. */
  private missionStartMs: number | undefined;
  /** Sqft cleaned at mission start; used for sqft-delta based advance (primary signal). */
  private missionStartSqft: number | undefined;
  /**
   * Highest selectedAreas index we've reached this mission. Skip commands advance
   * us decisively (e.g. room 1 → room 2); the time-based fallback must never drag
   * us back to a room we've already left. This ratchet enforces monotonic progress.
   */
  private missionMaxIndex = 0;

  constructor(
    private readonly connection: RoombaConnection,
    private readonly log: AnsiLogger,
    serialNumber: string,
    rooms: RoombaRoomConfig[] | undefined,
    serverMode: boolean,
    pmapId?: string,
    userPmapvId?: string,
    roomCleanDurationMinutes?: number,
    roomCleanSqft?: number,
  ) {
    this.serverMode = serverMode;
    this.rooms = rooms ?? [];
    this.pmapId = pmapId;
    this.userPmapvId = userPmapvId;
    this.roomCleanDurationMs = Math.max(1, roomCleanDurationMinutes ?? 10) * 60_000;
    this.roomCleanSqft = Math.max(1, roomCleanSqft ?? 75);
    this.deviceName = connection.getDeviceName();
    this.serialNumber = serialNumber;

    const supportedAreas = buildSupportedAreas(rooms);
    // CurrentArea must reference a valid id in supportedAreas (or null); pick the first
    // configured area's id so Matter conformance is satisfied no matter what ids the
    // user chose.
    const currentArea = supportedAreas[0].areaId;

    // 'server' = independent Matter server node with its own QR/passcode (recommended for
    // RVC in Apple Home / Google Home). 'matter'/undefined = bridged under the aggregator.
    const mode: 'server' | 'matter' | undefined = serverMode ? 'server' : undefined;

    this.device = new RoboticVacuumCleaner(
      this.deviceName,
      serialNumber,
      mode,
      RUN_MODE_IDLE,
      SUPPORTED_RUN_MODES,
      CLEAN_MODE_VACUUM,
      SUPPORTED_CLEAN_MODES,
      undefined, // currentPhase
      undefined, // phaseList
      RvcOperationalState.OperationalState.Docked,
      SUPPORTED_OP_STATES,
      supportedAreas,
      [], // selectedAreas
      currentArea,
      [], // supportedMaps
    );

    this.configureCommandHandlers();
    this.listenForStateUpdates();
  }

  /**
   * Apply identifying metadata (vendor, model, firmware) to the BridgedDeviceBasicInformation
   * cluster that Matterbridge adds when wrapping the device in the bridge aggregator.
   * Should be called BEFORE registering the device with Matterbridge.
   */
  applyIdentity(info: RoombaInfo, vendorName: string, modelOverride?: string): void {
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
        this.device.createDefaultBasicInformationClusterServer(
          this.deviceName,
          this.serialNumber,
          0xfff1,
          vendorName,
          0x8000,
          model,
          swNum,
          info.softwareVer,
          hwNum,
          info.hardwareVer,
        );
      } else {
        // Bridged mode: the controller reads BridgedDeviceBasicInformation from the
        // bridged endpoint. Call both so older controllers that read BasicInformation
        // get the right vendor/model too.
        this.device.createDefaultBasicInformationClusterServer(
          this.deviceName,
          this.serialNumber,
          0xfff1,
          vendorName,
          0x8000,
          model,
          swNum,
          info.softwareVer,
          hwNum,
          info.hardwareVer,
        );
        this.device.createDefaultBridgedDeviceBasicInformationClusterServer(
          this.deviceName,
          this.serialNumber,
          0xfff1,
          vendorName,
          model,
          swNum,
          info.softwareVer,
          hwNum,
          info.hardwareVer,
        );
      }
      this.log.info(
        `Applied identity to ${this.deviceName}: vendor=${vendorName} model=${model} sw=${info.softwareVer} hw=${info.hardwareVer}`,
      );
      this.log.debug(
        `  Endpoint fields now: vendorName="${this.device.vendorName}" productName="${this.device.productName}" productId=${this.device.productId} softwareVersionString="${this.device.softwareVersionString}" uniqueId="${this.device.uniqueId}" mode=${this.serverMode ? 'server' : 'bridged'}`,
      );
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
    } catch (err) {
      this.log.warn(`Failed to apply device identity: ${err}`);
    }
  }

  private pendingRootOverride?: {
    vendorName: string;
    productName: string;
    softwareVersion: number;
    softwareVersionString: string;
    hardwareVersion: number;
    hardwareVersionString: string;
  };

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
  async overrideRootNodeIdentity(): Promise<void> {
    if (!this.serverMode || !this.pendingRootOverride) return;
    // `serverNode` is attached by matterbridge in createDeviceServerNode — it's a
    // matter.js ServerNode whose endpoint-0 `basicInformation` we need to patch.
    const serverNode = (this.device as unknown as { serverNode?: { set: (state: unknown) => Promise<void> } }).serverNode;
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
      this.log.info(
        `Root node identity overridden for ${this.deviceName}: ` +
          `vendorName=${this.pendingRootOverride.vendorName} ` +
          `productName=${this.pendingRootOverride.productName} ` +
          `softwareVersionString=${this.pendingRootOverride.softwareVersionString}`,
      );
    } catch (err) {
      this.log.warn(`Failed to override root node identity for ${this.deviceName}: ${err}`);
    }
  }

  private configureCommandHandlers(): void {
    // Identify: make the robot beep
    this.device.addCommandHandler('identify', async () => {
      this.log.info(`Identify requested for ${this.connection.getDeviceName()}`);
      try {
        await this.connection.find();
      } catch (err) {
        this.log.warn(`Failed to identify robot: ${err}`);
      }
    });

    // RvcRunMode: change run mode (start/stop cleaning).
    // If the controller has called `selectAreas` with one or more rooms, start a
    // room-targeted clean via the dorita980 `cleanRoom` command — otherwise a whole-home
    // clean. Roomba requires pmapId + userPmapvId for room cleans; if those aren't in
    // the config the room path degrades to a whole-home clean with a log warning.
    this.device.addCommandHandler('changeToMode', async ({ request }) => {
      const newMode = request.newMode;
      this.log.info(`changeToMode requested: ${newMode}`);
      try {
        if (newMode === RUN_MODE_CLEANING) {
          const status = this.connection.getStatus();
          if (status.paused) {
            await this.connection.resume();
          } else {
            await this.startCleaning();
          }
        } else if (newMode === RUN_MODE_MAPPING) {
          this.log.info('Starting mapping / training run');
          await this.connection.train();
        } else if (newMode === RUN_MODE_IDLE) {
          await this.connection.stop();
        }
      } catch (err) {
        this.log.warn(`Failed to change run mode: ${err}`);
      }
    });

    // ServiceArea: record which rooms the controller wants cleaned. The actual
    // clean command is sent once the controller transitions RvcRunMode to Cleaning.
    this.device.addCommandHandler('selectAreas', async ({ request }) => {
      const newAreas = (request.newAreas ?? []) as number[];
      this.selectedAreas = [...newAreas];
      this.log.info(`selectAreas requested: [${newAreas.join(', ')}]`);
      // Also mirror into the cluster attribute so controllers can read it back.
      try {
        this.device.setAttribute('serviceArea', 'selectedAreas', this.selectedAreas, this.log);
      } catch (err) {
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
      } catch (err) {
        this.log.warn(`Failed to pause: ${err}`);
      }
    });

    this.device.addCommandHandler('resume', async () => {
      this.log.info('Resume requested');
      try {
        await this.connection.resume();
      } catch (err) {
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
          } catch (err) {
            this.log.debug(`goHome: stop() returned ${err}; continuing to dock anyway`);
          }
          // Brief settle time so the robot processes the stop before we tell it to dock.
          await new Promise((resolve) => setTimeout(resolve, 1500));
        }
        await this.connection.dock();
      } catch (err) {
        this.log.warn(`Failed to dock: ${err}`);
      }
    });
  }

  /**
   * Decide between a whole-home and a room-targeted clean based on the current
   * `selectedAreas`. Called when the controller transitions RvcRunMode -> Cleaning.
   */
  private async startCleaning(): Promise<void> {
    if (this.selectedAreas.length === 0) {
      // Whole-home clean: clear any stale per-area state from a previous room mission.
      this.log.info('Starting whole-home clean (no areas selected)');
      this.setCurrentArea(null);
      await this.connection.clean();
      return;
    }
    this.log.info(
      `startCleaning: ${this.selectedAreas.length} area(s) selected: [${this.selectedAreas.join(', ')}]`,
    );

    // Resolve Matter areaIds back to Roomba region metadata.
    const regions: Array<{ region_id: string; type: string }> = [];
    const unmappedAreas: number[] = [];
    for (const areaId of this.selectedAreas) {
      const room = this.rooms.find((r) => r.areaId === areaId);
      if (!room || !room.regionId) {
        unmappedAreas.push(areaId);
        continue;
      }
      regions.push({ region_id: room.regionId, type: room.regionType ?? 'rid' });
    }

    if (unmappedAreas.length > 0) {
      this.log.warn(
        `selectAreas referenced Matter areaId(s) [${unmappedAreas.join(', ')}] that have no regionId in config — ` +
          `falling back to whole-home clean. Run discovery mode to capture regionIds and add them to rooms[].`,
      );
      this.setCurrentArea(null);
      await this.connection.clean();
      return;
    }
    if (!this.pmapId) {
      this.log.warn(
        `selectAreas requested but no pmapId configured for ${this.deviceName} — falling back to whole-home clean. ` +
          `Add the discovered pmapId/userPmapvId to your device config.`,
      );
      this.setCurrentArea(null);
      await this.connection.clean();
      return;
    }

    this.log.info(
      `Starting room-targeted clean for ${regions.length} region(s): ` +
        `${regions.map((r) => r.region_id).join(', ')}`,
    );
    // Snapshot the mission baseline. We cycle currentArea using sqft cleaned
    // (preferred: pauses with the robot during recharge/stuck events) and fall
    // back to wall-clock elapsed when sqft isn't increasing.
    const startStatus = this.connection.getStatus();
    this.missionStartMs = Date.now();
    this.missionStartSqft = startStatus.missionSqft;
    this.missionMaxIndex = 0;
    this.setCurrentArea(this.selectedAreas[0]);
    await this.connection.cleanRoom(this.pmapId, this.userPmapvId, regions);
  }

  /**
   * While a multi-room mission is in progress, compute which area the robot is
   * likely cleaning right now and update `currentArea`. Prefers `sqft` progress
   * (Roomba's own cumulative-cleaned measure, pauses during recharge) over
   * wall-clock elapsed time. Fallback kicks in for firmware that doesn't emit
   * `sqft` or when sqft hasn't incremented yet.
   */
  private advanceCurrentAreaFromProgress(status: RoombaStatus): void {
    if (this.selectedAreas.length <= 1) return;

    const totalRooms = this.selectedAreas.length;
    let indexRaw: number;
    let signal: string;

    const sqftDelta = Math.max(0, status.missionSqft - (this.missionStartSqft ?? 0));
    if (sqftDelta > 0) {
      // sqft-driven: advance every `roomCleanSqft` of cleaned area.
      indexRaw = Math.floor(sqftDelta / this.roomCleanSqft);
      signal = `sqft=${sqftDelta.toFixed(0)} (threshold ${this.roomCleanSqft}/room)`;
    } else if (this.missionStartMs !== undefined) {
      // Time-driven fallback.
      const elapsedMs = Date.now() - this.missionStartMs;
      indexRaw = Math.floor(elapsedMs / this.roomCleanDurationMs);
      signal = `elapsed=${Math.round(elapsedMs / 60000)}min`;
    } else {
      return;
    }

    // Ratchet: never regress past the highest index we've reached this mission.
    // Skip commands (handled separately) bump missionMaxIndex directly; the
    // time-based estimate below it is just a safety net that catches up if no
    // skip was issued.
    const index = Math.min(Math.max(indexRaw, this.missionMaxIndex), totalRooms - 1);
    if (index > this.missionMaxIndex) this.missionMaxIndex = index;
    const targetArea = this.selectedAreas[index];
    if (targetArea !== this.lastPushed.currentArea) {
      this.log.info(
        `Advancing currentArea to ${targetArea} (room ${index + 1}/${totalRooms}, ${signal})`,
      );
      this.setCurrentArea(targetArea);
    }
  }

  /**
   * Write the ServiceArea.currentArea attribute. Guarded against errors because
   * some controllers don't include the attribute on all feature sets.
   */
  private setCurrentArea(areaId: number | null): void {
    if (!this.endpointActive) {
      this.lastPushed.currentArea = areaId;
      return;
    }
    if (areaId === this.lastPushed.currentArea) return;
    try {
      this.device.setAttribute('serviceArea', 'currentArea', areaId, this.log);
      this.lastPushed.currentArea = areaId;
    } catch (err) {
      this.log.debug(`Failed to set currentArea=${areaId}: ${err}`);
    }
  }

  private listenForStateUpdates(): void {
    this.connection.on('stateUpdate', (status: RoombaStatus) => {
      this.updateMatterState(status);
    });
    // User pressed "skip room" on the iRobot app — immediately advance currentArea
    // past the skipped region if it matches one we're tracking. This is the most
    // reliable real-time signal for per-region transitions; time-based cycling is
    // only a fallback when no skip is observed.
    this.connection.on('regionsSkipped', (skippedRegionIds: string[]) => {
      this.handleRegionsSkipped(skippedRegionIds);
    });
  }

  /**
   * When the iRobot app fires a skip for a region, advance `currentArea` to the
   * next selected area after the skipped one. If the skipped region isn't in
   * `selectedAreas` at all, it was an iRobot-app-initiated clean outside of
   * Matter's selection — leave state alone.
   */
  private handleRegionsSkipped(skippedRegionIds: string[]): void {
    if (this.selectedAreas.length <= 1) return;
    for (const regionId of skippedRegionIds) {
      const room = this.rooms.find((r) => r.regionId === regionId);
      if (!room) continue;
      const skippedIdx = this.selectedAreas.indexOf(room.areaId);
      if (skippedIdx === -1) continue;
      // Advance to the next selected area after the skipped one (clamped).
      const nextIdx = Math.min(skippedIdx + 1, this.selectedAreas.length - 1);
      // Bump the mission-max ratchet BEFORE writing currentArea so the time-based
      // advance on the same state-update cycle can't regress us back to the skipped
      // room a millisecond later.
      if (nextIdx > this.missionMaxIndex) this.missionMaxIndex = nextIdx;
      const nextArea = this.selectedAreas[nextIdx];
      if (nextArea !== this.lastPushed.currentArea) {
        this.log.info(
          `Region ${regionId} skipped; advancing currentArea to ${nextArea} (room ${nextIdx + 1}/${this.selectedAreas.length})`,
        );
        this.setCurrentArea(nextArea);
      }
    }
  }

  /**
   * Mark the underlying Matter endpoint as ready to accept attribute writes.
   * Should be called from the platform's onConfigure() once the server is online.
   */
  markActive(): void {
    this.endpointActive = true;
  }

  /**
   * Cache of last-pushed attribute values so we only call setAttribute when something
   * actually changed. Roomba state messages arrive every ~2s during active cleaning,
   * and matterbridge logs every setAttribute — without a diff here, the log gets
   * spammed with "from X to X" noise.
   */
  private lastPushed: {
    runMode?: number;
    opState?: number;
    errorStateId?: number;
    batteryPct?: number;
    batChargeLevel?: number;
    batChargeState?: number;
    currentArea?: number | null;
  } = {};
  /** Tracks whether the robot was running on the previous state update so we can detect the running→idle transition. */
  private wasActive = false;
  /**
   * True once we've seen `tankLevel > 0` at least once — proves the robot has a
   * water tank installed. Without this, we'd spuriously report "Water Tank Empty"
   * for every vacuum-only model (whose tankLvl just never gets set).
   */
  private robotHasSeenTank = false;

  /**
   * Push current Roomba state to the Matter device attributes, skipping writes whose
   * value hasn't changed since the previous push.
   */
  updateMatterState(status: RoombaStatus): void {
    if (!this.endpointActive) return;
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
      if (status.tankLevel > 0) this.robotHasSeenTank = true;
      if (errorState.errorStateId !== this.lastPushed.errorStateId) {
        this.device.setAttribute('rvcOperationalState', 'operationalError', errorState, this.log);
        // Also fire the Matter event so event-based subscribers (Apple Home
        // notifications, HA automations) get a push for the transition.
        if (errorState.errorStateId !== RvcOperationalState.ErrorState.NoError) {
          this.device
            .triggerEvent('rvcOperationalState', 'operationalError', errorState, this.log)
            .catch((err) => this.log.debug(`triggerEvent operationalError failed: ${err}`));
          this.log.info(
            `Robot error transition: id=${errorState.errorStateId} (Roomba errorCode=${status.errorCode}, binFull=${status.binFull}, tankLevel=${status.tankLevel})`,
          );
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
      if (this.wasActive && !isActive) {
        if (this.lastPushed.currentArea !== null) {
          this.setCurrentArea(null);
        }
        if (this.selectedAreas.length > 0) {
          this.selectedAreas = [];
          try {
            this.device.setAttribute('serviceArea', 'selectedAreas', [], this.log);
          } catch (err) {
            this.log.debug(`Failed to clear selectedAreas: ${err}`);
          }
        }
        this.missionStartMs = undefined;
        this.missionStartSqft = undefined;
      } else if (status.running && this.selectedAreas.length > 1) {
        // During an active multi-room mission, advance `currentArea` on each state
        // update so Apple Home's UI progresses from room to room instead of being
        // stuck on the first one. Driven by the robot's cumulative sqft cleaned
        // (or elapsed time when sqft isn't emitted).
        this.advanceCurrentAreaFromProgress(status);
      }
      this.wasActive = isActive;
    } catch (err) {
      this.log.debug(`Error updating Matter state: ${err}`);
    }
  }

  /**
   * Set initial device state on configure.
   */
  initializeState(): void {
    const status = this.connection.getStatus();
    this.updateMatterState(status);
  }
}

/**
 * Roomba reports firmware versions like "lewis+3.20.13.57". Extract the numeric portion
 * and pack it into a 32-bit integer Matter can store (major*10000 + minor*100 + patch).
 */
function parseSoftwareVersion(ver: string): number {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(ver);
  if (!match) return 1;
  const [, major, minor, patch] = match;
  return Number(major) * 10000 + Number(minor) * 100 + Number(patch);
}

function parseHardwareVersion(ver: string): number {
  const match = /(\d+)/.exec(ver);
  return match ? Number(match[1]) : 1;
}
