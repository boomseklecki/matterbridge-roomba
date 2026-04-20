/**
 * Maps Roomba states to Matter cluster values for RvcRunMode,
 * RvcOperationalState, and PowerSource.
 */

import { RvcOperationalState } from 'matterbridge/matter/clusters';
import type { RoombaStatus } from './roombaConnection.js';

// --- Run Mode IDs ---
export const RUN_MODE_IDLE = 1;
export const RUN_MODE_CLEANING = 2;
export const RUN_MODE_MAPPING = 3;

// --- Clean Mode IDs ---
// Matter spec: mode IDs are arbitrary uint8; what matters for controller UX is the
// `modeTags` carried on each entry. We pick stable IDs so config references stay
// valid across plugin restarts.
export const CLEAN_MODE_VACUUM = 1;
export const CLEAN_MODE_MOP = 2;
export const CLEAN_MODE_VACUUM_THEN_MOP = 3;
export const CLEAN_MODE_DEEP_CLEAN = 4;

/**
 * Map Roomba status to a Matter RvcRunMode mode ID. Roomba reports a training
 * mission via `cleanMissionStatus.cycle === 'train'` — distinguish from normal
 * cleaning so controllers show the right run-mode pill.
 */
export function statusToRunMode(status: RoombaStatus): number {
  if (status.running) {
    return status.cycle === 'train' ? RUN_MODE_MAPPING : RUN_MODE_CLEANING;
  }
  return RUN_MODE_IDLE;
}

/**
 * Map Roomba status to a Matter RvcOperationalState. We prioritise reporting
 * actively cleaning / returning home over a full bin, because the robot is still
 * in motion and controllers show "Cleaning" as the primary UI affordance — the
 * bin-full condition gets delivered separately via the OperationalError event.
 * Once the robot stops (docked, paused, or Stopped for another reason), bin-full
 * transitions the state to Error.
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
  // Once the robot has settled, surface the bin-full signal as an error so
  // controllers highlight that the user needs to empty it.
  if (status.binFull) {
    return RvcOperationalState.OperationalState.Error;
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
/**
 * Map a Roomba error code (plus an optional bin-full / tank signals) to a Matter
 * RVC error state. Roomba emits dozens of internal error codes; Matter's RVC cluster
 * has a much smaller enum, so many codes collapse onto `Stuck` /
 * `UnableToCompleteOperation`. The specific RVC codes (DustBinFull, WaterTankEmpty,
 * FailedToFindChargedDock, MopCleaningPadMissing) light up dedicated UI in Apple
 * Home / Google Home / Home Assistant — worth mapping accurately.
 *
 * NOTE: `errorStateLabel` / `errorStateDetails` are only permitted for manufacturer-
 * specific error IDs (>= 128) per the Matter spec. For the standard RVC IDs used
 * below we omit those fields.
 *
 * Roomba error code reference:
 *   https://homesupport.irobot.com/s/article/9149
 */
export function errorCodeToMatterError(
  errorCode: number,
  opts: { binFull?: boolean; tankEmpty?: boolean } = {},
): RvcOperationalState.ErrorStateStruct {
  // "No Matter error code" → fall through to the augmentation below so we can
  // surface bin/tank signals that Roomba reports orthogonally to `error`.
  if (errorCode === 0) {
    if (opts.binFull) return { errorStateId: RvcOperationalState.ErrorState.DustBinFull };
    if (opts.tankEmpty) return { errorStateId: RvcOperationalState.ErrorState.WaterTankEmpty };
    return { errorStateId: RvcOperationalState.ErrorState.NoError };
  }

  switch (errorCode) {
    // Wheel / drive stalls → WheelsJammed (dedicated Matter 1.4 state).
    case 7: // Left wheel stall
    case 8: // Right wheel stall
      return { errorStateId: RvcOperationalState.ErrorState.WheelsJammed };

    // Brush stalls → BrushJammed (dedicated Matter 1.4 state).
    case 10: // Side brush stall
    case 11: // Main brush stall
    case 12: // Side brush stall (alt)
    case 34: // Brush stall (j-series variant)
      return { errorStateId: RvcOperationalState.ErrorState.BrushJammed };

    // Navigation / sensors — occluded or confused.
    case 17: // Navigation problem
    case 22: // Sensor dirty
    case 54: // Navigation hardware
      return { errorStateId: RvcOperationalState.ErrorState.NavigationSensorObscured };

    // Room-target-specific routing failures (happens on zone cleans only).
    case 73: // Cannot reach target area (some firmware)
      return { errorStateId: RvcOperationalState.ErrorState.CannotReachTargetArea };

    // General stuck (wheels hanging, bumper, cliff, uneven surface).
    case 1: // Left wheel hanging
    case 2: // Right wheel hanging
    case 3: // Left bump stuck
    case 4: // Right bump stuck
    case 6: // Cliff sensor
    case 9: // Bumper stuck
    case 13: // Uneven surface
    case 31: // Stuck / cliff
    case 52: // Stuck pico
      return { errorStateId: RvcOperationalState.ErrorState.Stuck };

    // Bin
    case 15: // Bin full
      return { errorStateId: RvcOperationalState.ErrorState.DustBinFull };
    case 16: // Bin not detected (evac station sometimes)
    case 25: // Bin removed mid-mission
      return { errorStateId: RvcOperationalState.ErrorState.DustBinMissing };

    // Water tank (m-series / combo models). Roomba's internal codes line up
    // numerically with Matter's enum here by coincidence.
    case 68: // Water tank empty
      return { errorStateId: RvcOperationalState.ErrorState.WaterTankEmpty };
    case 69: // Water tank missing
      return { errorStateId: RvcOperationalState.ErrorState.WaterTankMissing };
    case 70: // Water tank lid open
      return { errorStateId: RvcOperationalState.ErrorState.WaterTankLidOpen };
    case 71: // Mop cleaning pad missing
      return { errorStateId: RvcOperationalState.ErrorState.MopCleaningPadMissing };

    // Battery / docking
    case 14: // Battery too low
    case 46: // Low battery near dock
      return { errorStateId: RvcOperationalState.ErrorState.LowBattery };
    case 19: // Undocking failed
    case 20: // Robot can't get back to the dock
    case 21: // Dock not found
    case 43: // Close to dock but can't seat
      return { errorStateId: RvcOperationalState.ErrorState.FailedToFindChargingDock };

    // Catch-all for internal / hardware / cancellation errors.
    case 5: // Internal error
    case 18: // Hardware problem
    case 38: // Communication error
    case 41: // Mission cancelled
    case 42: // Short mission
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
