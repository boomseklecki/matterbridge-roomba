/**
 * Roomba vacuum cleaner device for Matterbridge.
 * Wraps the RoboticVacuumCleaner base class and handles command routing.
 */

import { RoboticVacuumCleaner } from 'matterbridge/devices';
import { RvcRunMode, RvcCleanMode, RvcOperationalState } from 'matterbridge/matter/clusters';
import type { AnsiLogger } from 'matterbridge/logger';
import type { RoombaConnection, RoombaStatus } from './roombaConnection.js';
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

// Operational states
const SUPPORTED_OP_STATES: RvcOperationalState.OperationalStateStruct[] = [
  { operationalStateId: RvcOperationalState.OperationalState.Stopped, operationalStateLabel: 'Stopped' },
  { operationalStateId: RvcOperationalState.OperationalState.Running, operationalStateLabel: 'Running' },
  { operationalStateId: RvcOperationalState.OperationalState.Paused, operationalStateLabel: 'Paused' },
  { operationalStateId: RvcOperationalState.OperationalState.Error, operationalStateLabel: 'Error' },
  { operationalStateId: RvcOperationalState.OperationalState.SeekingCharger, operationalStateLabel: 'Returning to Dock' },
  { operationalStateId: RvcOperationalState.OperationalState.Charging, operationalStateLabel: 'Charging' },
  { operationalStateId: RvcOperationalState.OperationalState.Docked, operationalStateLabel: 'Docked' },
];

export class RoombaDevice {
  public readonly device: RoboticVacuumCleaner;

  constructor(
    private readonly connection: RoombaConnection,
    private readonly log: AnsiLogger,
    serialNumber: string,
  ) {
    const deviceName = connection.getDeviceName();

    this.device = new RoboticVacuumCleaner(
      deviceName,
      serialNumber,
      undefined, // mode: use default bridge mode
      RUN_MODE_IDLE, // currentRunMode
      SUPPORTED_RUN_MODES, // supportedRunModes
      CLEAN_MODE_VACUUM, // currentCleanMode
      SUPPORTED_CLEAN_MODES, // supportedCleanModes
      undefined, // currentPhase
      undefined, // phaseList
      RvcOperationalState.OperationalState.Docked, // operationalState
      SUPPORTED_OP_STATES, // operationalStateList
    );

    this.configureCommandHandlers();
    this.listenForStateUpdates();
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
   * Push current Roomba state to the Matter device attributes.
   */
  updateMatterState(status: RoombaStatus): void {
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
