/**
 * Matterbridge platform for iRobot Roomba vacuum cleaners.
 */
import { MatterbridgeDynamicPlatform, type PlatformConfig, type PlatformMatterbridge } from 'matterbridge';
import type { AnsiLogger } from 'matterbridge/logger';
export declare class RoombaMatterbridgePlatform extends MatterbridgeDynamicPlatform {
    private readonly connections;
    private readonly roombaDevices;
    private readonly platformConfig;
    private reconnectTimers;
    private reconnectAttempts;
    private shuttingDown;
    constructor(matterbridge: PlatformMatterbridge, log: AnsiLogger, config: PlatformConfig);
    onStart(reason?: string): Promise<void>;
    /**
     * If `cloud.email` + `cloud.password` are set, call the iRobot cloud API to fetch
     * all robots on the account. Any device in config that's missing blid/password has
     * those fields filled in from the cloud record with the matching name (or the sole
     * robot on a single-robot account). If `devices` is empty entirely, every cloud
     * robot is auto-added with a placeholder config (user still supplies ipAddress).
     *
     * Mutates `devices` in place.
     */
    private resolveCloudCredentials;
    private setupDevice;
    /** Log a single mission as it arrives so users can correlate id -> physical room. */
    private logMission;
    /**
     * Pretty-print the accumulated room discoveries in a form the user can drop straight
     * into the plugin config under `rooms`. Named regions keep type `rid`; everything else
     * is labelled a placeholder so the user knows to rename it.
     */
    private logDiscoveredRooms;
    onConfigure(): Promise<void>;
    /**
     * Invoked by matterbridge when the user clicks Confirm in the config UI.
     * We use it to implement one-shot "action toggles": a boolean field in the
     * schema, when flipped true, triggers an action here and is then reset to
     * false and re-saved so it behaves like a push-button.
     */
    onConfigChanged(config: PlatformConfig): Promise<void>;
    /** Hit the cloud API with the configured credentials and log what we find. */
    private runTestCloudLogin;
    /**
     * Pull currently-accumulated room discoveries out of each connection's in-memory
     * cache, merge them into the device configs (preserving user-renamed rooms), and
     * persist via `saveConfig`. The user then only needs to rename the rooms they
     * care about — nothing else to edit.
     */
    private runApplyDiscoveredRooms;
    onShutdown(reason?: string): Promise<void>;
    private scheduleReconnect;
}
//# sourceMappingURL=platform.d.ts.map