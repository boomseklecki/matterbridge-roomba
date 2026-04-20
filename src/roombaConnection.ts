/**
 * Roomba connection manager using dorita980 for local MQTT communication.
 */

import { Local, type RobotState } from 'dorita980';
import { EventEmitter } from 'events';
import type { AnsiLogger } from 'matterbridge/logger';

const ROBOT_CIPHERS = ['AES128-SHA256', 'TLS_AES_256_GCM_SHA384'];
const CONNECT_TIMEOUT_MS = 30_000;

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

export interface RoombaInfo {
  name: string;
  sku: string;
  softwareVer: string;
  hardwareVer: string;
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
}

export class RoombaConnection extends EventEmitter {
  private robot: Local | null = null;
  private cipherIndex = 0;
  private connected = false;
  private connecting = false;
  private disconnectEmitted = false;
  private latestState: RobotState = {};
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private readonly activeRefreshMs: number;
  private readonly idleRefreshMs: number;
  /** Accumulated map of pmap_id -> discovered rooms, populated while `discoverRooms` is on. */
  private readonly discoveredMaps = new Map<string, DiscoveredMap>();

  constructor(
    private readonly config: RoombaDeviceConfig,
    private readonly log: AnsiLogger,
  ) {
    super();
    this.activeRefreshMs = (config.refreshInterval ?? 10) * 1000;
    this.idleRefreshMs = (config.idleRefreshInterval ?? 120) * 1000;
  }

  async connect(): Promise<void> {
    if (this.connected || this.connecting) return;
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
        } catch (err) {
          this.log.warn(`Connection failed with cipher ${cipher}: ${err}`);
          this.teardownRobot();
          this.cipherIndex = (this.cipherIndex + 1) % ROBOT_CIPHERS.length;
        }
      }

      throw new Error(`Failed to connect to Roomba ${this.config.blid} after trying all ciphers`);
    } finally {
      this.connecting = false;
    }
  }

  private attemptConnect(cipher: string): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error('Connection timed out'));
      }, CONNECT_TIMEOUT_MS);

      try {
        this.robot = new Local(this.config.blid, this.config.password, this.config.ipAddress, 2, {
          ciphers: cipher,
        });

        this.robot.on('connect', () => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          this.connected = true;
          this.startPolling();
          resolve();
        });

        this.robot.on('state', (state: RobotState) => {
          this.mergeState(state);
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

        this.robot.on('error', (...args: unknown[]) => {
          const err = args[0] instanceof Error ? args[0] : new Error(String(args[0]));
          if (!settled) {
            settled = true;
            clearTimeout(timeout);
            reject(err);
          }
        });
      } catch (err) {
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      }
    });
  }

  private handleDisconnect(reason: string): void {
    this.connected = false;
    this.stopPolling();
    this.teardownRobot();
    if (!this.disconnectEmitted) {
      this.disconnectEmitted = true;
      this.log.debug(`Roomba ${this.config.blid} disconnect emitted (reason: ${reason})`);
      this.emit('disconnected');
    }
  }

  private teardownRobot(): void {
    if (!this.robot) return;
    try {
      this.robot.removeAllListeners();
    } catch {
      // ignore
    }
    try {
      this.robot.end();
    } catch {
      // ignore
    }
    this.robot = null;
  }

  private mergeState(state: RobotState): void {
    Object.assign(this.latestState, state);
    this.captureDiscovery(state);
  }

  private lastSeenCommandTime: number | undefined;

  /**
   * If a `lastCommand` with regions has just arrived, merge its regions into the discovered
   * map set and emit a `roomsDiscovered` event with the accumulated catalog.
   * Also emits a per-mission `roomsInMission` event describing what was in the command
   * we just observed — handy for correlating region IDs with the room you pressed
   * "Clean" on in the iRobot app.
   */
  private captureDiscovery(state: RobotState): void {
    const lc = state.lastCommand;
    if (!lc || !lc.pmap_id || !Array.isArray(lc.regions) || lc.regions.length === 0) return;

    // Only fire once per distinct mission (lastCommand.time is the mission timestamp).
    if (lc.time && lc.time === this.lastSeenCommandTime) return;
    this.lastSeenCommandTime = lc.time;

    const existing = this.discoveredMaps.get(lc.pmap_id) ?? {
      pmapId: lc.pmap_id,
      userPmapvId: lc.user_pmapv_id,
      regions: [],
    };
    if (lc.user_pmapv_id) existing.userPmapvId = lc.user_pmapv_id;

    const newRegionIds: string[] = [];
    for (const region of lc.regions) {
      if (!region || !region.region_id) continue;
      if (existing.regions.some((r) => r.regionId === region.region_id)) continue;
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
    });

    if (newRegionIds.length > 0) {
      this.emit('roomsDiscovered', Array.from(this.discoveredMaps.values()));
    }
  }

  /** Returns the current discovery catalog (may be empty). */
  getDiscoveredMaps(): DiscoveredMap[] {
    return Array.from(this.discoveredMaps.values());
  }

  getInfo(): RoombaInfo {
    const s = this.latestState;
    return {
      name: s.name ?? this.config.name ?? `Roomba ${this.config.blid}`,
      sku: (s.sku as string | undefined) ?? this.config.model ?? 'Roomba',
      softwareVer: (s.softwareVer as string | undefined) ?? 'unknown',
      hardwareVer: (s.hardwareVer as string | undefined) ?? 'unknown',
    };
  }

  getStatus(): RoombaStatus {
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
    };
  }

  private startPolling(): void {
    this.stopPolling();
    const status = this.getStatus();
    const interval = status.running || status.docking ? this.activeRefreshMs : this.idleRefreshMs;
    this.refreshTimer = setInterval(() => {
      this.refreshState();
    }, interval);
  }

  private stopPolling(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  private async refreshState(): Promise<void> {
    if (!this.robot || !this.connected) return;
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
    } catch (err) {
      this.log.debug(`Failed to refresh state for ${this.config.blid}: ${err}`);
    }
  }

  /**
   * Wait briefly for at least one MQTT state message from the robot, then return whatever
   * identifying fields we've accumulated. Unlike `getRobotState`, this does NOT block until
   * every requested field has been seen — some fields (e.g. `hardwareVer`) may never arrive
   * from newer models, so we take a best-effort snapshot instead.
   */
  async fetchIdentity(timeoutMs = 5_000): Promise<RoombaInfo> {
    if (!this.connected) {
      throw new Error('Not connected');
    }
    if (this.latestState.sku || this.latestState.softwareVer) {
      return this.getInfo();
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      const once = () => {
        clearTimeout(timer);
        resolve();
      };
      this.once('stateUpdate', once);
    });
    return this.getInfo();
  }

  async clean(): Promise<void> {
    if (!this.robot) throw new Error('Not connected');
    await this.robot.clean();
  }

  /**
   * Start a room-targeted clean. `regions` must contain one or more
   * `{ region_id, type }` pairs — the robot rejects the command if any region is
   * not present in its active pmap. `pmapId` + `userPmapvId` identify which map
   * version those regions belong to.
   */
  async cleanRoom(
    pmapId: string,
    userPmapvId: string | undefined,
    regions: Array<{ region_id: string; type: string }>,
  ): Promise<void> {
    if (!this.robot) throw new Error('Not connected');
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

  async pause(): Promise<void> {
    if (!this.robot) throw new Error('Not connected');
    await this.robot.pause();
  }

  async resume(): Promise<void> {
    if (!this.robot) throw new Error('Not connected');
    await this.robot.resume();
  }

  async stop(): Promise<void> {
    if (!this.robot) throw new Error('Not connected');
    await this.robot.stop();
  }

  async dock(): Promise<void> {
    if (!this.robot) throw new Error('Not connected');
    await this.robot.dock();
  }

  async find(): Promise<void> {
    if (!this.robot) throw new Error('Not connected');
    await this.robot.find();
  }

  disconnect(): void {
    this.stopPolling();
    this.teardownRobot();
    this.connected = false;
    // Intentionally do not emit 'disconnected' on explicit disconnect.
    this.disconnectEmitted = true;
  }

  isConnected(): boolean {
    return this.connected;
  }

  getBlid(): string {
    return this.config.blid;
  }

  getDeviceName(): string {
    return this.config.name ?? `Roomba ${this.config.blid}`;
  }
}
