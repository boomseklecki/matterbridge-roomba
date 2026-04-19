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
  CLEAN_MODE_VACUUM,
  statusToRunMode,
  statusToOperationalState,
  errorCodeToMatterError,
  batteryToChargeLevel,
} from './stateMapping.js';

// Run modes: Roomba only supports Idle and Cleaning (no mapping mode)
const SUPPORTED_RUN_MODES: RvcRunMode.ModeOption[] = [
  { label: 'Idle', mode: RUN_MODE_IDLE, modeTags: [{ value: RvcRunMode.ModeTag.Idle }] },
  { label: 'Cleaning', mode: RUN_MODE_CLEANING, modeTags: [{ value: RvcRunMode.ModeTag.Cleaning }] },
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

  constructor(
    private readonly connection: RoombaConnection,
    private readonly log: AnsiLogger,
    serialNumber: string,
    rooms: RoombaRoomConfig[] | undefined,
  ) {
    this.deviceName = connection.getDeviceName();
    this.serialNumber = serialNumber;

    const supportedAreas = buildSupportedAreas(rooms);
    // CurrentArea must reference a valid id in supportedAreas (or null); pick the first
    // configured area's id so Matter conformance is satisfied no matter what ids the
    // user chose.
    const currentArea = supportedAreas[0].areaId;

    this.device = new RoboticVacuumCleaner(
      this.deviceName,
      serialNumber,
      undefined, // mode: let matterbridge decide (bridged under aggregator)
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
    try {
      this.device.createDefaultBridgedDeviceBasicInformationClusterServer(
        this.deviceName,
        this.serialNumber,
        0xfff1, // keep the Matterbridge test vendorId; Apple Home doesn't show it anyway
        vendorName,
        model,
        parseSoftwareVersion(info.softwareVer),
        info.softwareVer,
        parseHardwareVersion(info.hardwareVer),
        info.hardwareVer,
      );
      this.log.debug(
        `Applied identity to ${this.deviceName}: vendor=${vendorName} model=${model} sw=${info.softwareVer} hw=${info.hardwareVer}`,
      );
    } catch (err) {
      this.log.warn(`Failed to apply device identity: ${err}`);
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

    // RvcRunMode: change run mode (start/stop cleaning)
    this.device.addCommandHandler('changeToMode', async ({ request }) => {
      const newMode = request.newMode;
      this.log.info(`changeToMode requested: ${newMode}`);
      try {
        if (newMode === RUN_MODE_CLEANING) {
          const status = this.connection.getStatus();
          if (status.paused) {
            await this.connection.resume();
          } else {
            await this.connection.clean();
          }
        } else if (newMode === RUN_MODE_IDLE) {
          await this.connection.stop();
        }
      } catch (err) {
        this.log.warn(`Failed to change run mode: ${err}`);
      }
    });

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
        await this.connection.dock();
      } catch (err) {
        this.log.warn(`Failed to dock: ${err}`);
      }
    });
  }

  private listenForStateUpdates(): void {
    this.connection.on('stateUpdate', (status: RoombaStatus) => {
      this.updateMatterState(status);
    });
  }

  /**
   * Mark the underlying Matter endpoint as ready to accept attribute writes.
   * Should be called from the platform's onConfigure() once the server is online.
   */
  markActive(): void {
    this.endpointActive = true;
  }

  /**
   * Push current Roomba state to the Matter device attributes.
   */
  updateMatterState(status: RoombaStatus): void {
    if (!this.endpointActive) return;
    try {
      // Update RvcRunMode
      const runMode = statusToRunMode(status);
      this.device.setAttribute('rvcRunMode', 'currentMode', runMode, this.log);

      // Update RvcOperationalState
      const opState = statusToOperationalState(status);
      this.device.setAttribute('rvcOperationalState', 'operationalState', opState, this.log);

      // Update error state
      const errorState = errorCodeToMatterError(status.errorCode);
      this.device.setAttribute('rvcOperationalState', 'operationalError', errorState, this.log);

      // Update battery (Matter spec: batPercentRemaining is 0-200, representing 0-100% in 0.5% steps)
      this.device.setAttribute('powerSource', 'batPercentRemaining', Math.min(status.batteryLevel * 2, 200), this.log);
      this.device.setAttribute('powerSource', 'batChargeLevel', batteryToChargeLevel(status.batteryLevel), this.log);

      // Charge state: 0 = Unknown, 1 = IsCharging, 2 = IsAtFullCharge, 3 = IsNotCharging
      let chargeState = 3; // IsNotCharging
      if (status.charging) {
        chargeState = status.batteryLevel >= 100 ? 2 : 1;
      }
      this.device.setAttribute('powerSource', 'batChargeState', chargeState, this.log);
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
