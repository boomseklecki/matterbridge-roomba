/**
 * Roomba vacuum cleaner device for Matterbridge.
 * Wraps the RoboticVacuumCleaner base class and handles command routing.
 */
import { RoboticVacuumCleaner } from 'matterbridge/devices';
import type { AnsiLogger } from 'matterbridge/logger';
import type { RoombaConnection, RoombaInfo, RoombaStatus, RoombaRoomConfig, RoombaMapConfig } from './roombaConnection.js';
import type { RoombaFamily } from './roombaConnection.js';
/**
 * Build the `SupportedModes` list for RvcCleanMode based on the robot's family
 * classification. A Matter-spec-compliant implementation:
 *   - vacuum-only robots: [Vacuum]
 *   - mop-only robots (Braava m-series): [Mop]
 *   - swappable (j5/j6 with sold-separately mop reservoir): [Vacuum, Mop]
 *     Runtime gating rejects the mode that doesn't match the installed tool.
 *   - combo (j7/j9 Combo, auto-switching): [Vacuum, Mop, VacuumThenMop]
 *     Also expose DeepClean which maps to Roomba's two-pass carpet mode.
 *
 * We always include at least one entry (Matter conformance requires a non-empty
 * SupportedModes list). DeepClean is added across all vacuum-capable families
 * because `carpetBoost` is available on any Roomba with floor-type detection.
 */
interface CleanModeCapabilities {
    multiPass: boolean;
    carpetBoost: boolean;
}
export declare class RoombaDevice {
    private readonly connection;
    private readonly log;
    readonly device: RoboticVacuumCleaner;
    private endpointActive;
    private readonly deviceName;
    private readonly serialNumber;
    private readonly serverMode;
    private readonly rooms;
    private readonly maps;
    private readonly pmapId;
    private readonly userPmapvId;
    private readonly roomCleanDurationMs;
    private readonly roomCleanSqft;
    /** Matter areaIds currently selected by the controller (from `selectAreas`). */
    private selectedAreas;
    /** Wall-clock time the current multi-room mission started; fallback advance signal. */
    private missionStartMs;
    /** Sqft cleaned at mission start; used for sqft-delta based advance (primary signal). */
    private missionStartSqft;
    /**
     * Highest selectedAreas index we've reached this mission. Skip commands advance
     * us decisively (e.g. room 1 → room 2); the time-based fallback must never drag
     * us back to a room we've already left. This ratchet enforces monotonic progress.
     */
    private missionMaxIndex;
    private readonly family;
    private readonly iosAllRoomsWorkaround;
    /** Most recent RvcCleanMode the controller asked for. Checked at startCleaning time. */
    private pendingCleanMode;
    constructor(connection: RoombaConnection, log: AnsiLogger, serialNumber: string, rooms: RoombaRoomConfig[] | undefined, serverMode: boolean, pmapId?: string, userPmapvId?: string, roomCleanDurationMinutes?: number, roomCleanSqft?: number, family?: RoombaFamily, maps?: RoombaMapConfig[] | undefined, cleanCapabilities?: CleanModeCapabilities, iosAllRoomsWorkaround?: boolean);
    /**
     * Apply identifying metadata (vendor, model, firmware) to the BridgedDeviceBasicInformation
     * cluster that Matterbridge adds when wrapping the device in the bridge aggregator.
     * Should be called BEFORE registering the device with Matterbridge.
     */
    applyIdentity(info: RoombaInfo, vendorName: string, modelOverride?: string): void;
    private pendingRootOverride?;
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
    overrideRootNodeIdentity(): Promise<void>;
    private configureCommandHandlers;
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
    private validateCleanMode;
    /**
     * Decide between a whole-home and a room-targeted clean based on the current
     * `selectedAreas`. Called when the controller transitions RvcRunMode -> Cleaning.
     */
    private startCleaning;
    /**
     * While a multi-room mission is in progress, compute which area the robot is
     * likely cleaning right now and update `currentArea`. Prefers `sqft` progress
     * (Roomba's own cumulative-cleaned measure, pauses during recharge) over
     * wall-clock elapsed time. Fallback kicks in for firmware that doesn't emit
     * `sqft` or when sqft hasn't incremented yet.
     */
    private advanceCurrentAreaFromProgress;
    /**
     * Write the ServiceArea.currentArea attribute. Guarded against errors because
     * some controllers don't include the attribute on all feature sets.
     */
    private setCurrentArea;
    private listenForStateUpdates;
    /**
     * When the iRobot app fires a skip for a region, advance `currentArea` to the
     * next selected area after the skipped one. If the skipped region isn't in
     * `selectedAreas` at all, it was an iRobot-app-initiated clean outside of
     * Matter's selection — leave state alone.
     */
    private handleRegionsSkipped;
    /**
     * Mark the underlying Matter endpoint as ready to accept attribute writes.
     * Should be called from the platform's onConfigure() once the server is online.
     */
    markActive(): void;
    /**
     * Flip the `reachable` attribute on BridgedDeviceBasicInformation. Apple Home
     * reads this to display "No Response" on an accessory tile when the robot is
     * unreachable; matter.js auto-fires the `ReachableChanged` event when the
     * attribute transitions. Safe to call before `markActive()` — we skip the
     * write silently in that case, avoiding the "endpoint inactive" error spam.
     */
    setReachable(reachable: boolean): void;
    /**
     * Cache of last-pushed attribute values so we only call setAttribute when something
     * actually changed. Roomba state messages arrive every ~2s during active cleaning,
     * and matterbridge logs every setAttribute — without a diff here, the log gets
     * spammed with "from X to X" noise.
     */
    private lastPushed;
    /** Tracks whether the robot was running on the previous state update so we can detect the running→idle transition. */
    private wasActive;
    /**
     * Mission-level state carried across state updates so we can synthesize a
     * single `OperationCompletion` event at the running→idle edge with the total
     * elapsed time. Matter 1.4 §7.5.7.2 — this event lets Apple Home (iOS 18.4+)
     * push a "cleaning finished" notification to the user's phone.
     */
    private missionActive;
    private missionStartTs;
    private missionLastError;
    /**
     * True once we've seen `tankLevel > 0` at least once — proves the robot has a
     * water tank installed. Without this, we'd spuriously report "Water Tank Empty"
     * for every vacuum-only model (whose tankLvl just never gets set).
     */
    private robotHasSeenTank;
    /**
     * Push current Roomba state to the Matter device attributes, skipping writes whose
     * value hasn't changed since the previous push.
     */
    updateMatterState(status: RoombaStatus): void;
    /**
     * Set initial device state on configure.
     */
    initializeState(): void;
}
export {};
//# sourceMappingURL=roombaDevice.d.ts.map