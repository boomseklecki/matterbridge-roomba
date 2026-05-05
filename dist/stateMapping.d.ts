/**
 * Maps Roomba states to Matter cluster values for RvcRunMode,
 * RvcOperationalState, and PowerSource.
 */
import { RvcOperationalState } from 'matterbridge/matter/clusters';
import type { RoombaStatus } from './roombaConnection.js';
export declare const RUN_MODE_IDLE = 1;
export declare const RUN_MODE_CLEANING = 2;
export declare const RUN_MODE_MAPPING = 3;
export declare const CLEAN_MODE_VACUUM = 1;
export declare const CLEAN_MODE_MOP = 2;
export declare const CLEAN_MODE_VACUUM_THEN_MOP = 3;
export declare const CLEAN_MODE_DEEP_CLEAN = 4;
export declare const CLEAN_MODE_MAX = 5;
export declare const CLEAN_MODE_QUICK = 6;
/**
 * Map Roomba status to a Matter RvcRunMode mode ID. Roomba reports a training
 * mission via `cleanMissionStatus.cycle === 'train'` — distinguish from normal
 * cleaning so controllers show the right run-mode pill.
 */
export declare function statusToRunMode(status: RoombaStatus): number;
/**
 * Map Roomba status to a Matter RvcOperationalState. We prioritise reporting
 * actively cleaning / returning home over a full bin, because the robot is still
 * in motion and controllers show "Cleaning" as the primary UI affordance — the
 * bin-full condition gets delivered separately via the OperationalError event.
 * Once the robot stops (docked, paused, or Stopped for another reason), bin-full
 * transitions the state to Error.
 */
export declare function statusToOperationalState(status: RoombaStatus): number;
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
export declare function errorCodeToMatterError(errorCode: number, opts?: {
    binFull?: boolean;
    tankEmpty?: boolean;
}): RvcOperationalState.ErrorStateStruct;
/**
 * Map battery level to PowerSource charge level.
 */
export declare function batteryToChargeLevel(batteryPct: number): number;
//# sourceMappingURL=stateMapping.d.ts.map