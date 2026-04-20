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
      /** Cumulative square feet cleaned in the current mission. Pauses when the robot recharges. */
      sqft?: number;
      /** Mission start time, Unix epoch seconds. */
      mssnStrtTm?: number;
      initiator: string;
      nMssn: number;
    };
    /**
     * Historical mission averages the robot keeps in flash. `aMssnM` is the user's
     * home-specific average whole-home mission length in minutes. Useful for
     * calibrating per-room progress estimates.
     */
    bbmssn?: {
      aMssnM?: number;
      nMssnC?: number;
      nMssnF?: number;
      nMssnOk?: number;
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
    /**
     * Installed tool on swappable / combo models. Reports whether the dust bin
     * is physically present and its type. When the user swaps a bin-only Roomba
     * (j5/j6) over to a mop reservoir, `bin.present` flips to false and the mop
     * fields below populate.
     * - `bin.type`: "std" (standard bin), varies for combo/mop carriers
     */
    bin?: {
      present?: boolean;
      full?: boolean;
      type?: string;
    };
    /** Water tank level 0-100. Only populated when a mop/combo tool is installed. */
    tankLvl?: number;
    /** Combo-model mop readiness gate. */
    mopReady?: {
      tankPresent?: boolean;
      lidClosed?: boolean;
    };
    /**
     * Detected mop pad type on Combo / Braava models.
     * Values: "reusableDry", "reusableWet", "dispDry", "dispWet", "invalid", ...
     */
    detectedPad?: string;
    padWetness?: {
      disp?: number;
      reusable?: number;
    };
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
    cleanRoom(args: {
      ordered: number;
      pmap_id: string;
      user_pmapv_id?: string;
      regions: Array<{ region_id: string; type: string; params?: Record<string, unknown> }>;
    }): Promise<void>;
    pause(): Promise<void>;
    resume(): Promise<void>;
    stop(): Promise<void>;
    dock(): Promise<void>;
    find(): Promise<void>;
    /** Start a "Training Run" mission — robot explores the floor to refine its map. */
    train(): Promise<void>;
    /** Trigger the AutoEmpty dock to evacuate the bin (CleanBase models only). */
    evac(): Promise<void>;
    end(): void;

    getRobotState(fields: string[]): Promise<RobotState>;
  }
}
