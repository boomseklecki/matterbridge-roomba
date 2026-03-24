/**
 * Roomba connection manager using dorita980 for local MQTT communication.
 */

import { Local, type RobotState } from 'dorita980';
import { EventEmitter } from 'events';
import type { AnsiLogger } from 'matterbridge/logger';

const ROBOT_CIPHERS = ['AES128-SHA256', 'TLS_AES_256_GCM_SHA384'];
const CONNECT_TIMEOUT_MS = 30_000;

export interface RoombaDeviceConfig {
  name?: string;
  blid: string;
  password: string;
  ipAddress: string;
  refreshInterval?: number;
  idleRefreshInterval?: number;
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
  private latestState: RobotState = {};
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private readonly activeRefreshMs: number;
  private readonly idleRefreshMs: number;

  constructor(
    private readonly config: RoombaDeviceConfig,
    private readonly log: AnsiLogger,
  ) {
    super();
    this.activeRefreshMs = (config.refreshInterval ?? 10) * 1000;
    this.idleRefreshMs = (config.idleRefreshInterval ?? 120) * 1000;
  }

  async connect(): Promise<void> {
    if (this.connected) return;

    for (let attempt = 0; attempt < ROBOT_CIPHERS.length; attempt++) {
      const cipher = ROBOT_CIPHERS[this.cipherIndex];
      this.log.debug(`Connecting to Roomba ${this.config.blid} at ${this.config.ipAddress} (cipher: ${cipher})`);

      try {
        await this.attemptConnect(cipher);
        this.log.info(`Connected to Roomba ${this.config.blid}`);
        return;
      } catch (err) {
        this.log.warn(`Connection failed with cipher ${cipher}: ${err}`);
        this.cipherIndex = (this.cipherIndex + 1) % ROBOT_CIPHERS.length;
      }
    }

    throw new Error(`Failed to connect to Roomba ${this.config.blid} after trying all ciphers`);
  }

  private attemptConnect(cipher: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Connection timed out'));
        this.disconnect();
      }, CONNECT_TIMEOUT_MS);

      try {
        this.robot = new Local(this.config.blid, this.config.password, this.config.ipAddress, 2, {
          ciphers: cipher,
        });

        this.robot.on('connect', () => {
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
          this.connected = false;
          this.stopPolling();
          this.emit('disconnected');
        });

        this.robot.on('offline', () => {
          this.log.warn(`Roomba ${this.config.blid} went offline`);
          this.connected = false;
          this.stopPolling();
          this.emit('disconnected');
        });
      } catch (err) {
        clearTimeout(timeout);
        reject(err);
      }
    });
  }

  private mergeState(state: RobotState): void {
    Object.assign(this.latestState, state);
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

  async clean(): Promise<void> {
    if (!this.robot) throw new Error('Not connected');
    await this.robot.clean();
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
    if (this.robot) {
      try {
        this.robot.end();
      } catch {
        // Ignore errors during disconnect
      }
      this.robot = null;
    }
    this.connected = false;
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
