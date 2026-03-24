import type { PlatformConfig } from 'matterbridge'
import type { Roomba, RobotState } from 'dorita980'

import { RoboticVacuumCleaner } from 'matterbridge/devices'
import { AnsiLogger } from 'matterbridge/logger'
import dorita980 from 'dorita980'

// Numeric constants for @matter/types enums (avoids importing nested deps)
const RvcRunModeTag = { Idle: 16384, Cleaning: 16385 }
const RvcCleanModeTag = { Auto: 0, Vacuum: 16385 }
const RvcOpState = { Stopped: 0, Running: 1, Paused: 2, Error: 3, SeekingCharger: 64, Charging: 65, Docked: 66 }
const BatChargeLevel = { Ok: 0, Warning: 1, Critical: 2 }
const BatChargeState = { IsCharging: 1, IsNotCharging: 3 }

import type { MatterbridgeRoombaConfig, NamedMission } from './settings.js'
import type { MatterbridgeEndpoint } from 'matterbridge'

const CONNECT_TIMEOUT_MILLIS = 60_000
const USER_INTERESTED_MILLIS = 60_000
const AFTER_ACTIVE_MILLIS = 120_000
const STATUS_TIMEOUT_MILLIS = 60_000
const REFRESH_STATE_COALESCE_MILLIS = 10_000
const ROBOT_CIPHERS = ['AES128-SHA256', 'TLS_AES_256_GCM_SHA384']
const DEFAULT_IDLE_POLL_INTERVAL_MILLIS = 15 * 60 * 1000

export interface DeviceInfo {
  name: string
  blid: string
  serialNumber?: string
  password: string
  ip: string
  model: string
  softwareVer?: string
  missions?: NamedMission[]
  stopBehaviour?: 'home' | 'pause'
  idleWatchInterval?: number
}

interface RoombaHolder {
  readonly roomba: Roomba
  useCount: number
}

interface Status {
  timestamp: number
  running?: boolean
  docking?: boolean
  charging?: boolean
  paused?: boolean
  batteryLevel?: number
  binFull?: boolean
}

async function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function shouldTryDifferentCipher(error: Error): boolean {
  const msg = error.message
  return msg.includes('SSL') || msg.includes('ECONNRESET') || msg.includes('handshake')
}

export class RoombaDevice {
  readonly endpoint: MatterbridgeEndpoint

  private readonly blid: string
  private readonly robotpwd: string
  private readonly ipaddress: string
  private readonly missions: NamedMission[]
  private readonly stopBehaviour: 'home' | 'pause'
  private readonly idlePollIntervalMillis: number
  private readonly log: AnsiLogger

  private currentCipherIndex = 0
  private _currentRoombaPromise: Promise<RoombaHolder> | undefined
  private cachedStatus: Status = { timestamp: 0 }
  private lastUpdatedStatus: Partial<Status> = {}
  private userLastInterestedTimestamp = 0
  private roombaLastActiveTimestamp = 0
  private lastRefreshState = 0
  private currentPollTimeout: ReturnType<typeof setTimeout> | undefined
  private lastPollInterval = 0
  private stopped = false

  constructor(info: DeviceInfo, globalConfig: PlatformConfig, log: AnsiLogger) {
    this.log = log
    this.blid = info.blid
    this.robotpwd = info.password
    this.ipaddress = info.ip
    this.missions = info.missions ?? []
    this.stopBehaviour = info.stopBehaviour ?? 'home'

    const globalIdleMin = (globalConfig as MatterbridgeRoombaConfig).idleWatchInterval
    this.idlePollIntervalMillis = ((info.idleWatchInterval ?? globalIdleMin ?? 15) * 60 * 1000) || DEFAULT_IDLE_POLL_INTERVAL_MILLIS

    // Run modes: 1=Idle, 2=Cleaning (match MatterbridgeRvcRunModeServer's hardcoded assumptions)
    const supportedRunModes = [
      { label: 'Idle', mode: 1, modeTags: [{ value: RvcRunModeTag.Idle }] },
      { label: 'Cleaning', mode: 2, modeTags: [{ value: RvcRunModeTag.Cleaning }] },
    ]

    const supportedCleanModes = [
      { label: 'Vacuum', mode: 1, modeTags: [{ value: RvcCleanModeTag.Vacuum }] },
    ]

    const operationalStateList = [
      { operationalStateId: RvcOpState.Stopped },
      { operationalStateId: RvcOpState.Running },
      { operationalStateId: RvcOpState.Paused },
      { operationalStateId: RvcOpState.Error },
      { operationalStateId: RvcOpState.SeekingCharger },
      { operationalStateId: RvcOpState.Charging },
      { operationalStateId: RvcOpState.Docked },
    ]

    // RoboticVacuumCleaner constructor sets up BasicInformation and PowerSource clusters;
    // do not call createDefaultBridgedDeviceBasicInformationClusterServer or
    // createDefaultPowerSourceRechargeableBatteryClusterServer afterwards (would duplicate).
    const supportedAreas = [
      {
        areaId: 1,
        mapId: 1,
        areaInfo: {
          locationInfo: { locationName: 'Everywhere', floorNumber: null, areaType: null },
          landmarkInfo: null,
        },
      },
      ...this.missions.map((m, i) => ({
        areaId: i + 2,
        mapId: 1,
        areaInfo: {
          locationInfo: { locationName: m.name, floorNumber: null, areaType: null },
          landmarkInfo: null,
        },
      })),
    ]

    const supportedMaps = [{ mapId: 1, name: info.name }]

    this.endpoint = new RoboticVacuumCleaner(
      info.name,
      info.serialNumber ?? info.blid,
      'server',
      1,               // currentRunMode: 1=Idle
      supportedRunModes,
      1,               // currentCleanMode: 1=All Rooms
      supportedCleanModes,
      null,
      null,
      RvcOpState.Docked,
      operationalStateList,
      supportedAreas,
      [],              // selectedAreas
      undefined,       // currentArea
      supportedMaps,
    )

    this.setupCommandHandlers()
  }

  // areaId 1 = "Everywhere" (full clean); missions start at areaId 2
  private static readonly EVERYWHERE_AREA_ID = 1

  private selectedMissions(): NamedMission[] {
    const selected = this.endpoint.getAttribute('serviceArea', 'selectedAreas') as number[] | undefined
    if (!selected || selected.length === 0 || selected.includes(RoombaDevice.EVERYWHERE_AREA_ID)) return []
    return selected.flatMap(id => {
      const m = this.missions[id - 2]
      return m ? [m] : []
    })
  }

  private async startClean(roomba: import('dorita980').Roomba): Promise<void> {
    const missions = this.selectedMissions()

    if (missions.length === 0) {
      this.log.info('No areas selected — full vacuum')
      await roomba.clean()
      return
    }

    const withFavorite = missions.filter(m => m.favorite_id != null)
    const withoutFavorite = missions.filter(m => m.favorite_id == null)

    if (withFavorite.length > 0) {
      if (withFavorite.length > 1 || withoutFavorite.length > 0) {
        this.log.warn(
          'Multiple missions selected with favorite_id — running first (%s), ignoring others',
          withFavorite[0].name,
        )
      }
      this.log.info('Starting mission: %s (favorite_id: %s)', withFavorite[0].name, withFavorite[0].favorite_id)
      await roomba.cleanRoom(withFavorite[0])
      return
    }

    // All selected missions have no favorite_id — combine their regions
    const combined = {
      pmap_id: withoutFavorite[0].pmap_id,
      user_pmapv_id: withoutFavorite[0].user_pmapv_id,
      ordered: withoutFavorite[0].ordered ?? 1,
      regions: withoutFavorite.flatMap(m => m.regions),
    }
    this.log.info('Starting combined rooms: %s', withoutFavorite.map(m => m.name).join(', '))
    await roomba.cleanRoom(combined)
  }

  private setupCommandHandlers(): void {
    this.endpoint.addCommandHandler('RvcRunMode.changeToMode', async ({ request }) => {
      const { newMode } = request
      this.log.info('RvcRunMode.changeToMode → mode %s', newMode)

      if (newMode === 1) {
        // Idle
        this.connect(async (_error, roomba) => {
          if (!roomba) return
          try {
            if (this.stopBehaviour === 'home') {
              await roomba.pause()
              await this.dockWhenStopped(roomba, 3000)
            } else {
              await roomba.pause()
            }
            this.refreshStatusForUser()
          } catch (e) {
            this.log.warn('RunMode Idle failed: %s', (e as Error).message)
          }
        })
      } else {
        // Cleaning
        this.connect(async (_error, roomba) => {
          if (!roomba) return
          try {
            if (this.cachedStatus.paused) {
              await roomba.resume()
            } else {
              await this.startClean(roomba)
            }
            this.refreshStatusForUser()
          } catch (e) {
            this.log.warn('RunMode Cleaning failed: %s', (e as Error).message)
          }
        })
      }
    })

    this.endpoint.addCommandHandler('RvcCleanMode.changeToMode', async () => {
      // Only one clean mode (Vacuum); actual mission is determined by ServiceArea selectedAreas.
    })

    this.endpoint.addCommandHandler('RvcOperationalState.pause', async () => {
      this.log.info('RvcOperationalState.pause')
      this.connect(async (_error, roomba) => {
        if (!roomba) return
        try {
          await roomba.pause()
          this.refreshStatusForUser()
        } catch (e) {
          this.log.warn('pause failed: %s', (e as Error).message)
        }
      })
    })

    this.endpoint.addCommandHandler('RvcOperationalState.resume', async () => {
      this.log.info('RvcOperationalState.resume')
      this.connect(async (_error, roomba) => {
        if (!roomba) return
        try {
          await roomba.resume()
          this.refreshStatusForUser()
        } catch (e) {
          this.log.warn('resume failed: %s', (e as Error).message)
        }
      })
    })

    this.endpoint.addCommandHandler('RvcOperationalState.goHome', async () => {
      this.log.info('RvcOperationalState.goHome')
      this.connect(async (_error, roomba) => {
        if (!roomba) return
        try {
          await roomba.dock()
          this.refreshStatusForUser()
        } catch (e) {
          this.log.warn('goHome failed: %s', (e as Error).message)
        }
      })
    })
  }

  private async connectedRoomba(attempts = 0): Promise<RoombaHolder> {
    return new Promise<RoombaHolder>((resolve, reject) => {
      let connected = false
      let failed = false

      const roomba = dorita980.Local(this.blid, this.robotpwd, this.ipaddress, 2, {
        ciphers: ROBOT_CIPHERS[this.currentCipherIndex],
      })

      const startConnecting = Date.now()
      const timeout = setTimeout(() => {
        failed = true
        this.log.debug('Timed out connecting to Roomba after %ims', Date.now() - startConnecting)
        roomba.end()
        reject(new Error('Connect timed out'))
      }, CONNECT_TIMEOUT_MILLIS)

      roomba.on('state', (state: RobotState) => {
        this.receiveRobotState(state)
      })

      const onError = (error: Error) => {
        this.log.debug('Connection error: %s', error.message)
        roomba.off('error', onError)
        roomba.end()
        clearTimeout(timeout)

        if (!connected) {
          failed = true
          if (shouldTryDifferentCipher(error) && attempts < ROBOT_CIPHERS.length) {
            this.currentCipherIndex = (this.currentCipherIndex + 1) % ROBOT_CIPHERS.length
            this.log.debug('Retrying with cipher %s', ROBOT_CIPHERS[this.currentCipherIndex])
            this.connectedRoomba(attempts + 1).then(resolve).catch(reject)
          } else {
            reject(error)
          }
        }
      }
      roomba.on('error', onError)

      this.log.debug('Connecting to Roomba...')

      const onConnect = () => {
        roomba.off('connect', onConnect)
        clearTimeout(timeout)
        if (failed) return
        connected = true
        this.log.debug('Connected to Roomba in %ims', Date.now() - startConnecting)
        resolve({ roomba, useCount: 0 })
      }
      roomba.on('connect', onConnect)
    })
  }

  private connect(callback: (error: Error | null, roomba?: Roomba) => Promise<void>): void {
    this.log.debug('connect: have existing promise: %s', this._currentRoombaPromise ? 'yes' : 'no')
    const promise = this._currentRoombaPromise || this.connectedRoomba()
    this._currentRoombaPromise = promise

    promise.then((holder) => {
      holder.useCount++
      callback(null, holder.roomba).finally(() => {
        holder.useCount--
        if (holder.useCount <= 0) {
          this._currentRoombaPromise = undefined
          holder.roomba.end()
        }
      })
    }).catch((error: Error) => {
      this._currentRoombaPromise = undefined
      callback(error)
    })
  }

  private receiveRobotState(state: RobotState): void {
    if (this.receivedRobotStateIsComplete(state)) {
      const parsed = this.parseState(state)
      this.mergeCachedStatus(parsed)
    }
  }

  private receivedRobotStateIsComplete(state: RobotState): boolean {
    return state.batPct !== undefined && state.bin !== undefined && state.cleanMissionStatus !== undefined
  }

  private parseState(state: RobotState): Partial<Status> & { timestamp: number } {
    const status: Partial<Status> & { timestamp: number } = { timestamp: Date.now() }

    if (state.batPct !== undefined) {
      status.batteryLevel = state.batPct
    }
    if (state.bin !== undefined) {
      status.binFull = state.bin.full
    }

    if (state.cleanMissionStatus !== undefined) {
      switch (state.cleanMissionStatus.phase) {
        case 'run':
          status.running = true
          status.charging = false
          status.docking = false
          break
        case 'charge':
        case 'recharge':
          status.running = false
          status.charging = true
          status.docking = false
          break
        case 'hmUsrDock':
        case 'hmMidMsn':
        case 'hmPostMsn':
          status.running = false
          status.charging = false
          status.docking = true
          break
        case 'stop':
        case 'stuck':
        case 'evac':
        default:
          status.running = false
          status.charging = false
          status.docking = false
          break
      }
      status.paused = !status.running && state.cleanMissionStatus.cycle === 'clean'
    }

    return status
  }

  private mergeCachedStatus(status: Partial<Status> & { timestamp: number }): void {
    const newStatus: Status = {
      ...this.cachedStatus,
      ...status,
      timestamp: Date.now(),
    }
    this.cachedStatus = newStatus
    this.updateEndpointAttributes(newStatus)

    if (this.isActive()) {
      this.roombaLastActiveTimestamp = Date.now()
    }
  }

  private isEndpointActive(): boolean {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (this.endpoint as any).construction?.status === 'active'
  }

  private updateEndpointAttributes(status: Status): void {
    if (!this.isEndpointActive()) {
      this.log.debug('Endpoint not yet active, skipping attribute update')
      return
    }
    const runMode = status.running ? 2 : 1
    this.endpoint.updateAttribute('rvcRunMode', 'currentMode', runMode).catch((e: Error) => {
      this.log.debug('updateAttribute rvcRunMode failed: %s', e.message)
    })

    const opState = this.toOperationalState(status)
    this.endpoint.updateAttribute('rvcOperationalState', 'operationalState', opState).catch((e: Error) => {
      this.log.debug('updateAttribute rvcOperationalState failed: %s', e.message)
    })

    if (status.batteryLevel !== undefined) {
      const batPct = Math.min(200, status.batteryLevel * 2)
      this.endpoint.updateAttribute('powerSource', 'batPercentRemaining', batPct).catch((e: Error) => {
        this.log.debug('updateAttribute batPercentRemaining failed: %s', e.message)
      })

      const chargeLevel = status.batteryLevel <= 10
        ? BatChargeLevel.Critical
        : status.batteryLevel <= 20
          ? BatChargeLevel.Warning
          : BatChargeLevel.Ok
      this.endpoint.updateAttribute('powerSource', 'batChargeLevel', chargeLevel).catch((e: Error) => {
        this.log.debug('updateAttribute batChargeLevel failed: %s', e.message)
      })

      const chargeState = status.charging
        ? BatChargeState.IsCharging
        : BatChargeState.IsNotCharging
      this.endpoint.updateAttribute('powerSource', 'batChargeState', chargeState).catch((e: Error) => {
        this.log.debug('updateAttribute batChargeState failed: %s', e.message)
      })
    }

    this.lastUpdatedStatus = { ...this.lastUpdatedStatus, ...status }
  }

  private toOperationalState(status: Status): number {
    if (status.running) return RvcOpState.Running
    if (status.docking) return RvcOpState.SeekingCharger
    if (status.paused) return RvcOpState.Paused
    if (status.charging) return RvcOpState.Charging
    return RvcOpState.Docked
  }

  private refreshStatusForUser(): void {
    this.userLastInterestedTimestamp = Date.now()
    this.startPolling(true)
  }

  startPolling(adhoc?: boolean): void {
    if (this.stopped) return

    const checkStatus = (adhoc: boolean) => {
      if (this.stopped) return
      const now = Date.now()
      if (!adhoc || now - this.lastRefreshState > REFRESH_STATE_COALESCE_MILLIS) {
        this.lastRefreshState = now

        if (this.currentPollTimeout) {
          clearTimeout(this.currentPollTimeout)
          this.currentPollTimeout = undefined
        }

        this.refreshState(() => {
          if (this.stopped) return
          const interval = this.currentPollInterval()
          this.lastPollInterval = interval
          this.log.debug('Next Roomba poll in %is', interval / 1000)

          if (this.currentPollTimeout) {
            clearTimeout(this.currentPollTimeout)
            this.currentPollTimeout = undefined
          }
          this.currentPollTimeout = setTimeout(() => checkStatus(false), interval)
        })
      }
    }

    checkStatus(adhoc ?? false)
  }

  stopPolling(): void {
    this.stopped = true
    if (this.currentPollTimeout) {
      clearTimeout(this.currentPollTimeout)
      this.currentPollTimeout = undefined
    }
  }

  disconnect(): void {
    if (this._currentRoombaPromise) {
      this._currentRoombaPromise.then(holder => {
        holder.roomba.end()
      }).catch(() => { /* ignore */ })
      this._currentRoombaPromise = undefined
    }
  }

  private refreshState(callback: () => void): void {
    const timeout = setTimeout(() => {
      this.log.debug('refreshState timed out')
      callback()
    }, STATUS_TIMEOUT_MILLIS)

    this.connect(async (error, roomba) => {
      if (error || !roomba) {
        clearTimeout(timeout)
        this.log.debug('refreshState connect error: %s', (error as Error)?.message)
        callback()
        return
      }

      await new Promise<void>((resolve) => {
        const updateState = (state: RobotState) => {
          if (this.receivedRobotStateIsComplete(state)) {
            this.receiveRobotState(state)
            roomba.off('state', updateState)
            clearTimeout(timeout)
            resolve()
            callback()
          }
        }
        roomba.on('state', updateState)
      })
    })
  }

  private currentPollInterval(): number {
    const timeSinceUserLastInterested = Date.now() - this.userLastInterestedTimestamp
    if (timeSinceUserLastInterested < USER_INTERESTED_MILLIS) {
      return 5_000
    }

    const timeSinceLastActive = Date.now() - this.roombaLastActiveTimestamp
    if (this.isActive() || timeSinceLastActive < AFTER_ACTIVE_MILLIS) {
      return 10_000
    }

    return this.idlePollIntervalMillis
  }

  private isActive(): boolean {
    return this.cachedStatus.running === true || this.cachedStatus.docking === true
  }

  private async dockWhenStopped(roomba: Roomba, pollingInterval: number): Promise<void> {
    try {
      const state = await roomba.getRobotState(['cleanMissionStatus'])
      switch (state.cleanMissionStatus?.phase) {
        case 'stop':
          await roomba.dock()
          this.refreshStatusForUser()
          break
        case 'run':
          await delay(pollingInterval)
          await this.dockWhenStopped(roomba, pollingInterval)
          break
        default:
          break
      }
    } catch (e) {
      this.log.warn('dockWhenStopped failed: %s', (e as Error).message)
    }
  }
}
