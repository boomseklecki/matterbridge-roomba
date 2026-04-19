/**
 * Maps Roomba states to Matter cluster values for RvcRunMode,
 * RvcOperationalState, and PowerSource.
 */

import { RvcOperationalState } from 'matterbridge/matter/clusters';
import type { RoombaStatus } from './roombaConnection.js';

// --- Run Mode IDs ---
export const RUN_MODE_IDLE = 1;
export const RUN_MODE_CLEANING = 2;

// --- Clean Mode IDs ---
export const CLEAN_MODE_VACUUM = 1;

/**
 * Map Roomba status to a Matter RvcRunMode mode ID.
 */
export function statusToRunMode(status: RoombaStatus): number {
  if (status.running) return RUN_MODE_CLEANING;
  return RUN_MODE_IDLE;
}

/**
 * Map Roomba status to a Matter RvcOperationalState.
 */
export function statusToOperationalState(status: RoombaStatus): number {
  if (status.errorCode !== 0 || status.stuck) {
    return RvcOperationalState.OperationalState.Error;
  }
  if (status.running) {
    return RvcOperationalState.OperationalState.Running;
  }
  if (status.paused) {
    return RvcOperationalState.OperationalState.Paused;
  }
  if (status.docking) {
    return RvcOperationalState.OperationalState.SeekingCharger;
  }
  if (status.charging) {
    if (status.batteryLevel >= 100) {
      return RvcOperationalState.OperationalState.Docked;
    }
    return RvcOperationalState.OperationalState.Charging;
  }
  return RvcOperationalState.OperationalState.Docked;
}

/**
 * Map Roomba error code to a Matter ErrorState.
 */
export function errorCodeToMatterError(errorCode: number): RvcOperationalState.ErrorStateStruct {
  // NOTE: `errorStateLabel`/`errorStateDetails` are only permitted for manufacturer-specific
  // error IDs (>= 128) per the Matter spec. For standard RVC error IDs we omit them.
  if (errorCode === 0) {
    return { errorStateId: RvcOperationalState.ErrorState.NoError };
  }

  switch (errorCode) {
    case 1: // Left wheel hanging
    case 2: // Right wheel hanging
    case 3: // Left bump stuck
    case 4: // Right bump stuck
    case 6: // Cliff sensor
    case 7: // Left wheel stall
    case 8: // Right wheel stall
    case 9: // Bumper stuck
    case 10: // Side brush stall
    case 11: // Main brush stall
    case 12: // Side brush stall
    case 13: // Uneven surface
    case 17: // Navigation problem
      return { errorStateId: RvcOperationalState.ErrorState.Stuck };

    case 15: // Bin full
    case 16: // Bin not detected
      return { errorStateId: RvcOperationalState.ErrorState.DustBinFull };

    case 14: // Battery too low
    case 19: // Undocking failed
      return { errorStateId: RvcOperationalState.ErrorState.LowBattery };

    case 5: // Internal error
    case 18: // Hardware problem
    default:
      return { errorStateId: RvcOperationalState.ErrorState.UnableToCompleteOperation };
  }
}

/**
 * Map battery level to PowerSource charge level.
 */
export function batteryToChargeLevel(batteryPct: number): number {
  // 0 = Ok, 1 = Warning, 2 = Critical (from PowerSource.BatChargeLevel)
  if (batteryPct >= 60) return 0;
  if (batteryPct >= 20) return 1;
  return 2;
}
