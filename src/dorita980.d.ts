declare module 'dorita980' {
  import { EventEmitter } from 'events';

  interface RobotState {
    batPct?: number;
    bin?: {
      present: boolean;
      full: boolean;
    };
    cleanMissionStatus?: {
      cycle: string;
      phase: string;
      expireM: number;
      rechrgM: number;
      error: number;
      notReady: number;
      mssnM: number;
      initiator: string;
      nMssn: number;
    };
    dock?: {
      known: boolean;
    };
    name?: string;
    sku?: string;
    softwareVer?: string;
    hardwareVer?: string;
    bootloaderVer?: string;
    mobilityVer?: string;
    batteryType?: string;
    tankLvl?: number;
    lastCommand?: {
      command: string;
      initiator: string;
      time: number;
      ordered: number;
      pmap_id?: string;
      user_pmapv_id?: string;
      regions?: Array<{
        region_id: string;
        type: string;
        params?: Record<string, unknown>;
      }>;
      select_all?: boolean;
    };
    [key: string]: unknown;
  }

  interface LocalOptions {
    ciphers?: string;
  }

  class Local extends EventEmitter {
    constructor(
      blid: string,
      password: string,
      ipAddress: string,
      firmwareVersion?: number,
      options?: LocalOptions,
    );

    on(event: 'connect', listener: () => void): this;
    on(event: 'close', listener: () => void): this;
    on(event: 'offline', listener: () => void): this;
    on(event: 'state', listener: (state: RobotState) => void): this;
    on(event: string, listener: (...args: unknown[]) => void): this;

    clean(): Promise<void>;
    cleanRoom(args: unknown): Promise<void>;
    pause(): Promise<void>;
    resume(): Promise<void>;
    stop(): Promise<void>;
    dock(): Promise<void>;
    find(): Promise<void>;
    end(): void;

    getRobotState(fields: string[]): Promise<RobotState>;
  }
}
