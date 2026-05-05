/**
 * Roomba connection manager using dorita980 for local MQTT communication.
 */
import { EventEmitter } from 'events';
import type { AnsiLogger } from 'matterbridge/logger';
export interface RoombaRoomConfig {
    /** Matter area ID (uint32). Must be unique per device. Presented to controllers. */
    areaId: number;
    /**
     * Roomba's internal region identifier, as reported by the robot in
     * `lastCommand.regions[*].region_id`. Required for room-targeted cleans to work —
     * the plugin translates the Matter areaId back to this string before sending the
     * `cleanRoom` command. If omitted, room-targeted cleans for this area fall back
     * to a whole-home clean.
     */
    regionId?: string;
    /**
     * Region type for the robot: `"rid"` for rooms (default), `"zid"` for zones.
     * Pulled from `lastCommand.regions[*].type` during discovery.
     */
    regionType?: string;
    /** User-facing room name shown in the Matter controller. */
    name: string;
    /**
     * Optional Matter AreaNamespace tag (from matterbridge/matter/tags),
     * e.g. "LivingRoom", "Kitchen", "Bedroom".
     */
    type?: string;
    /** Optional floor number (defaults to 0). */
    floor?: number;
    /**
     * Matter map id this room belongs to — must match a `mapId` in the device's
     * `maps` array. If omitted and `maps` is configured, falls back to the first
     * map. If `maps` is empty/unset, ignored.
     */
    mapId?: number;
    /**
     * Roomba's `favorite_id` for a saved mission. When set, dispatches a
     * `cleanRoom` with `favorite_id` + the captured `missionRegions` payload.
     * Takes priority over `regionId` and `missionRegionIds`.
     */
    favoriteId?: string;
    /**
     * Full region payload captured from `lastCommand` when `favoriteId` was
     * first discovered. Replayed on dispatch so per-region params (twoPass,
     * carpetBoost, etc.) are preserved exactly as configured in the iRobot app.
     * Auto-populated by `applyDiscoveredRooms`; can be left empty to let the
     * robot use its stored favorite preferences.
     */
    missionRegions?: Array<{
        regionId: string;
        type: string;
        params?: Record<string, unknown>;
    }>;
    /**
     * Pre-bundled list of regionIds to clean as a single area. When set, all
     * listed regions are included in one `cleanRoom` call. Use for a named
     * multi-room preset (e.g. "Main Floor").
     */
    missionRegionIds?: string[];
}
/**
 * A Roomba persistent map. Multi-map / multi-floor homes (j7+, j9+, s9+) have
 * distinct pmaps per floor; configure one entry per floor and each room points
 * at its owning map by `mapId`.
 */
export interface RoombaMapConfig {
    /** Matter map identifier (uint32). Must be unique within this device. */
    mapId: number;
    /** Human-readable label the Matter controller displays (e.g. "Main Floor"). */
    name: string;
    /**
     * Persistent map id this Matter map represents. Used when dispatching room
     * cleans — overrides the device-level `pmapId` for rooms on this map.
     */
    pmapId: string;
    /** User map version id that pairs with this `pmapId`. */
    userPmapvId?: string;
}
export interface RoombaDeviceConfig {
    name?: string;
    blid: string;
    password: string;
    ipAddress: string;
    refreshInterval?: number;
    idleRefreshInterval?: number;
    /** Marker set during platform startup when this device's creds came from cloud lookup. */
    _resolvedFromCloud?: boolean;
    /** Model name override for the Matter BasicInformation cluster (e.g. "Roomba j5+"). */
    model?: string;
    /** Vendor name override (default "iRobot"). */
    vendor?: string;
    /**
     * Expose the robot as its OWN independent Matter server node (own QR code, own pairing)
     * instead of a bridged endpoint under the Matterbridge aggregator.
     *
     * Default: `true`. Recommended for Apple Home and Google Home — both controllers
     * handle standalone RVC devices better than bridged ones (bridged mode causes metadata
     * to appear as "Matterbridge/Aggregator" and creates a ghost "unsupported device" in
     * single-device bridges).
     *
     * Set to `false` if you prefer a single pairing code for all Matterbridge plugins;
     * be aware that Apple Home may display the vacuum metadata incorrectly in that mode.
     */
    serverMode?: boolean;
    /** Optional list of rooms to expose as Matter service areas. */
    rooms?: RoombaRoomConfig[];
    /**
     * Optional list of maps. Provide one entry per pmap when a j-series or
     * s-series Roomba has Imprint Smart Maps for multiple floors. Each room's
     * `mapId` picks which map it lives on. If unset, the device is treated as
     * single-map and the top-level `pmapId` / `userPmapvId` apply to every room.
     */
    maps?: RoombaMapConfig[];
    /**
     * Persistent map identifier for this robot's active map (`pmap_id` from the
     * robot's `lastCommand`). Required for room-targeted cleans. Auto-captured in
     * discovery mode; user pastes into config alongside `rooms`.
     */
    pmapId?: string;
    /**
     * User's version identifier for the active map (`user_pmapv_id`). Required by
     * the `cleanRoom` command alongside `pmapId`. Auto-captured in discovery mode.
     */
    userPmapvId?: string;
    /**
     * When true, every time the robot reports a room-based clean command, the plugin
     * logs a copy-paste-ready JSON snippet with the captured region IDs. Turn on,
     * clean each room once from the iRobot app, copy the snippet into `rooms`,
     * turn this off.
     */
    discoverRooms?: boolean;
    /**
     * Estimated minutes per room. Fallback signal for advancing
     * `ServiceArea.currentArea` during a multi-room clean, used when the robot
     * isn't reporting `cleanMissionStatus.sqft` (rare on j5+/j7/j9/i/s models).
     * Default 10.
     */
    roomCleanDurationMinutes?: number;
    /**
     * Estimated square feet the robot cleans per room before the controller UI
     * advances to the next selected room. This is the PRIMARY signal (pauses
     * during recharge/stuck events, unlike wall-clock time). Default 75 sqft
     * (about 7 m²). Tune down for studio-sized rooms, up for open-plan spaces.
     */
    roomCleanSqft?: number;
    /**
     * Dev-only: dump every raw MQTT state delta to the log. Use to discover robot
     * state fields the plugin doesn't yet parse.
     */
    verboseState?: boolean;
    /**
     * Work around iOS Home's room-picker UI regression where picking "All Rooms"
     * (which Matter represents as `selectAreas([])`, an unconstrained mission)
     * leaves the picker checkboxes displaying only the first configured room.
     *
     * When enabled (default), the plugin echoes the FULL list of configured
     * areaIds back to the `SelectedAreas` attribute whenever the controller
     * sends an empty `selectAreas` command — so iOS Home's summary flip to
     * "All Rooms" after a few seconds. macOS Home handles the empty-list
     * semantic correctly and doesn't need this.
     *
     * This mildly violates Matter spec §1.17.6.4 ("SelectedAreas shall NOT be
     * updated outside of processing a SelectAreas command") — the two
     * representations are functionally identical for a Roomba, but a strict
     * controller could theoretically differentiate them. Disable this once
     * Apple ships a fix in iOS Home.
     */
    iosAllRoomsWorkaround?: boolean;
}
export interface DiscoveredRegion {
    regionId: string;
    type: string;
    /** First time we saw this region (ms since epoch). */
    firstSeen: number;
}
export interface DiscoveredMap {
    pmapId: string;
    userPmapvId?: string;
    regions: DiscoveredRegion[];
}
export interface DiscoveredFavorite {
    favoriteId: string;
    pmapId: string;
    userPmapvId?: string;
    /** Full region payload including per-region params — captured from lastCommand so it can be replayed exactly. */
    regions: Array<{
        regionId: string;
        type: string;
        params?: Record<string, unknown>;
    }>;
}
export interface RoombaInfo {
    name: string;
    sku: string;
    softwareVer: string;
    hardwareVer: string;
    /**
     * Capability flags the robot broadcasts over MQTT. We read a handful of fields
     * to decide which Matter clean modes to advertise — older models (i3+/i4+,
     * 600/700 series) don't support multi-pass or carpet boost, so offering
     * Quick/DeepClean on those is just lying to the controller.
     *
     * Field semantics, reverse-engineered across dorita980 / NickWaterton /
     * iRobot community threads:
     *   - multiPass: 0 = unsupported, >=1 = supports single/two-pass selection
     *   - carpetBoost: 0 = unsupported, >=1 = supports Eco/Auto/Performance
     *   - pp (power pass): Roomba's internal boost-on-carpet-auto toggle
     *   - eco: supports eco cleaning profile
     *   - edge: supports edge-clean toggle
     */
    capabilities: {
        multiPass: boolean;
        carpetBoost: boolean;
    };
}
/**
 * Robot hardware family classification, derived at startup from `sku`.
 * Drives which Matter `RvcCleanMode` options the plugin advertises.
 */
export type RoombaFamily = 
/** Vacuum-only (900, i1-i4, older). */
'vacuum'
/** Swappable: ships with a bin; owner can physically swap in a mop reservoir
 *  (j5, j6, some i7s). Mop and Vacuum modes are mutually exclusive at any moment. */
 | 'swappable'
/** Combo: integrated bin+tank, auto-switches per surface (j7 Combo, j9 Combo). */
 | 'combo'
/** Mop-only (Braava m6, m8). */
 | 'mop'
/** Unknown SKU — default to vacuum-only to avoid surfacing a mop option that doesn't work. */
 | 'unknown';
/**
 * Snapshot of the currently-installed cleaning tool, derived from MQTT state.
 * Used alongside `RoombaFamily` to decide which modes are currently *available*
 * (vs. theoretically supported) on swappable models.
 */
export interface RoombaInstalledTool {
    /** Dust bin is physically installed and ready to collect debris. */
    binInstalled: boolean;
    /** Water tank / mop reservoir is installed. */
    mopInstalled: boolean;
    /**
     * Combo-only: `detectedPad === "invalid"` or any pad error state.
     * Controllers should treat mop modes as blocked when this is true.
     */
    padFaulted: boolean;
}
export interface RoombaStatus {
    running: boolean;
    charging: boolean;
    docking: boolean;
    paused: boolean;
    stuck: boolean;
    batteryLevel: number;
    binFull: boolean;
    tankLevel: number;
    phase: string;
    errorCode: number;
    cycle: string;
    name: string;
    /** Cumulative square feet cleaned this mission (from cleanMissionStatus.sqft). */
    missionSqft: number;
    /** Mission elapsed minutes (from cleanMissionStatus.mssnM). */
    missionElapsedMin: number;
    /** Historical average mission length in minutes (from bbmssn.aMssnM). 0 if unknown. */
    avgMissionMin: number;
    /** Live-state tool detection used to gate Vacuum vs Mop clean modes. */
    installedTool: RoombaInstalledTool;
}
export declare class RoombaConnection extends EventEmitter {
    private readonly config;
    private readonly log;
    private robot;
    private cipherIndex;
    private connected;
    private connecting;
    private disconnectEmitted;
    private latestState;
    private refreshTimer;
    private readonly activeRefreshMs;
    private readonly idleRefreshMs;
    /** Accumulated map of pmap_id -> discovered rooms, populated while `discoverRooms` is on. */
    private readonly discoveredMaps;
    /** Accumulated map of favorite_id -> discovered missions. */
    private readonly discoveredFavorites;
    constructor(config: RoombaDeviceConfig, log: AnsiLogger);
    connect(): Promise<void>;
    private attemptConnect;
    private handleDisconnect;
    private teardownRobot;
    private mergeState;
    private lastSeenCommandTime;
    /** Tracks the most recent skip command we emitted, so we don't re-emit on state heartbeats. */
    private lastSkipCommandTime;
    /**
     * Detect when the user (or anyone) pressed the "skip room" button on the iRobot
     * app. This is the ONE real-time per-region signal Roomba firmware exposes —
     * `sqft`/`mssnM` stay at 0 on j5+/j7+ so time-based cycling is the only
     * automatic fallback, but skips let us advance currentArea precisely when a
     * human actually moves the robot past a room.
     */
    private captureSkipCommand;
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
    private captureDiscovery;
    /** Returns the current discovery catalog (may be empty). */
    getDiscoveredMaps(): DiscoveredMap[];
    /** Returns all favorites/missions captured from lastCommand (may be empty). */
    getDiscoveredFavorites(): DiscoveredFavorite[];
    /** Signature of the last mission/command/pose/bbmssn slice we logged, for dedup. */
    private lastVerboseSignatures;
    /**
     * Emit compact one-line log entries for the bits of robot state we care about,
     * but ONLY when they've changed since the last log. Robot sends heartbeat state
     * messages every ~2s; without this dedup the log gets spammed with identical lines.
     */
    private logStateDelta;
    getInfo(): RoombaInfo;
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
    classifyFamily(): RoombaFamily;
    /**
     * Read current tool installation from MQTT state. Used to gate which modes
     * are *currently* available on swappable models (owner physically swapped to
     * the mop reservoir) and to detect pad faults on combo units.
     */
    getInstalledTool(): RoombaInstalledTool;
    getStatus(): RoombaStatus;
    private startPolling;
    private stopPolling;
    private refreshState;
    /**
     * Wait briefly for at least one MQTT state message from the robot, then return whatever
     * identifying fields we've accumulated. Unlike `getRobotState`, this does NOT block until
     * every requested field has been seen — some fields (e.g. `hardwareVer`) may never arrive
     * from newer models, so we take a best-effort snapshot instead.
     */
    fetchIdentity(timeoutMs?: number): Promise<RoombaInfo>;
    clean(): Promise<void>;
    /** Start a mapping / training run (Roomba explores and refines its pmap). */
    train(): Promise<void>;
    /**
     * Apply a pair of cleaning-power preferences (carpet boost + passes). Used
     * when the controller picks a `RvcCleanMode` like Auto / Quick / Max /
     * DeepClean — each of these presets corresponds to a specific combination.
     * The robot stores these persistently; subsequent `clean()`/`cleanRoom()`
     * commands use whatever preset was last applied.
     */
    applyCleaningPreset(preset: 'auto' | 'quick' | 'max' | 'deep'): Promise<void>;
    /**
     * Start a room-targeted clean. `regions` must contain one or more
     * `{ region_id, type }` pairs — the robot rejects the command if any region is
     * not present in its active pmap. `pmapId` + `userPmapvId` identify which map
     * version those regions belong to.
     */
    cleanRoom(pmapId: string, userPmapvId: string | undefined, regions: Array<{
        region_id: string;
        type: string;
    }>): Promise<void>;
    /**
     * Dispatch a saved Roomba mission by `favorite_id`, replaying the full region
     * payload (including per-region params) exactly as captured from `lastCommand`.
     */
    cleanRoomByFavorite(pmapId: string, userPmapvId: string | undefined, favoriteId: string, regions: Array<{
        region_id: string;
        type: string;
        params?: Record<string, unknown>;
    }>): Promise<void>;
    pause(): Promise<void>;
    resume(): Promise<void>;
    stop(): Promise<void>;
    dock(): Promise<void>;
    find(): Promise<void>;
    disconnect(): void;
    isConnected(): boolean;
    getBlid(): string;
    getDeviceName(): string;
}
//# sourceMappingURL=roombaConnection.d.ts.map