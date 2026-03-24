declare module 'dorita980' {
  export interface RobotState {
    batPct?: number
    bin?: { full: boolean; present: boolean }
    tankLvl?: number
    cleanMissionStatus?: {
      cycle: string
      phase: string
      error: number
      notReady: number
      mssnM: number
      sqft: number
      initiator: string
      nMssn: number
    }
    lastCommand?: {
      pmap_id?: string
      user_pmapv_id?: string
      ordered?: number
      favorite_id?: string
      regions?: { region_id: string; type: string }[]
    }
  }

  export interface Roomba {
    on(event: 'connect', listener: () => void): this
    on(event: 'reconnect', listener: () => void): this
    on(event: 'close', listener: () => void): this
    on(event: 'offline', listener: () => void): this
    on(event: 'error', listener: (error: Error) => void): this
    on(event: 'state', listener: (data: RobotState) => void): this
    // eslint-disable-next-line @typescript-eslint/ban-types
    off(event: string, listener: Function): this
    removeAllListeners(event?: string | symbol): this
    end(): void
    getRobotState(waitForFields: string[]): Promise<RobotState>
    clean(): Promise<{ ok: null }>
    cleanRoom(mission: object): Promise<{ ok: null }>
    pause(): Promise<{ ok: null }>
    stop(): Promise<{ ok: null }>
    resume(): Promise<{ ok: null }>
    dock(): Promise<{ ok: null }>
  }

  export function Local(username: string, password: string, ip: string, version?: 2 | 3, options?: object | number): Roomba
  export function Cloud(username: string, password: string, version?: 1 | 2): object
  export function discovery(cb?: (err: Error | null, data: object) => void): Promise<object>
}
