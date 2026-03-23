import type { PlatformConfig, PlatformMatterbridge } from 'matterbridge'

import { MatterbridgeDynamicPlatform } from 'matterbridge'
import { AnsiLogger } from 'node-ansi-logger'

import type { MatterbridgeRoombaConfig } from './settings.js'

import { getRoombas } from './roomba.js'
import { RoombaDevice } from './roombaDevice.js'

export class RoombaPlatform extends MatterbridgeDynamicPlatform {
  private devices: RoombaDevice[] = []

  constructor(matterbridge: PlatformMatterbridge, log: AnsiLogger, config: PlatformConfig) {
    super(matterbridge, log, config)
  }

  override async onStart(reason?: string): Promise<void> {
    this.log.info('onStart called' + (reason ? `: ${reason}` : ''))

    const config = this.config as MatterbridgeRoombaConfig
    const configDevices = config.devices ?? []

    let discovered: { name: string; blid: string; password: string; ip: string; model: string; softwareVer?: string }[] = []

    if (config.email && config.password) {
      const robots = await getRoombas(config.email, config.password, this.log)
      discovered = robots.map(r => ({
        name: r.name,
        blid: r.blid,
        password: r.password,
        ip: r.ip,
        model: r.model,
        softwareVer: r.softwareVer,
      }))
    }

    // Merge: manual config overrides discovered entries by blid
    const mergedMap = new Map<string, {
      name: string
      blid: string
      password: string
      ip: string
      model: string
      softwareVer?: string
      missions?: import('./settings.js').NamedMission[]
      stopBehaviour?: 'home' | 'pause'
      idleWatchInterval?: number
    }>()

    for (const d of discovered) {
      mergedMap.set(d.blid, d)
    }

    for (const dev of configDevices) {
      const existing = mergedMap.get(dev.blid)
      mergedMap.set(dev.blid, {
        name: dev.name,
        blid: dev.blid,
        password: dev.robotpwd,
        ip: dev.ipaddress,
        model: existing?.model ?? 'Roomba',
        softwareVer: existing?.softwareVer,
        missions: dev.missions,
        stopBehaviour: dev.stopBehaviour,
        idleWatchInterval: dev.idleWatchInterval,
      })
    }

    for (const info of mergedMap.values()) {
      const device = new RoombaDevice(
        info,
        config,
        this.log,
      )
      this.devices.push(device)
      await this.registerDevice(device.endpoint)
    }
  }

  override async onConfigure(): Promise<void> {
    this.log.info('onConfigure called')

    for (const device of this.devices) {
      device.startPolling()
    }
  }

  override async onShutdown(reason?: string): Promise<void> {
    this.log.info('onShutdown called' + (reason ? `: ${reason}` : ''))

    for (const device of this.devices) {
      device.stopPolling()
      device.disconnect()
    }
  }
}
