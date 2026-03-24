/**
 * Matterbridge platform for iRobot Roomba vacuum cleaners.
 */

import {
  MatterbridgeDynamicPlatform,
  type PlatformConfig,
  type PlatformMatterbridge,
} from 'matterbridge';
import type { AnsiLogger } from 'matterbridge/logger';
import { RoombaConnection, type RoombaDeviceConfig } from './roombaConnection.js';
import { RoombaDevice } from './roombaDevice.js';

interface RoombaPlatformConfig extends PlatformConfig {
  devices?: RoombaDeviceConfig[];
  debug?: boolean;
}

export class RoombaMatterbridgePlatform extends MatterbridgeDynamicPlatform {
  private readonly connections: Map<string, RoombaConnection> = new Map();
  private readonly roombaDevices: Map<string, RoombaDevice> = new Map();
  private readonly platformConfig: RoombaPlatformConfig;
  private reconnectTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();

  constructor(matterbridge: PlatformMatterbridge, log: AnsiLogger, config: PlatformConfig) {
    super(matterbridge, log, config);
    this.platformConfig = config as RoombaPlatformConfig;
  }

  override async onStart(reason?: string): Promise<void> {
    this.log.info(`Starting Roomba plugin (reason: ${reason ?? 'unknown'})`);

    const devices = this.platformConfig.devices ?? [];
    if (devices.length === 0) {
      this.log.warn('No Roomba devices configured. Add devices in the plugin settings.');
      return;
    }

    for (const deviceConfig of devices) {
      try {
        await this.setupDevice(deviceConfig);
      } catch (err) {
        this.log.error(`Failed to set up Roomba ${deviceConfig.blid}: ${err}`);
      }
    }
  }

  private async setupDevice(deviceConfig: RoombaDeviceConfig): Promise<void> {
    const blid = deviceConfig.blid;
    this.log.info(`Setting up Roomba ${deviceConfig.name ?? blid}`);

    const connection = new RoombaConnection(deviceConfig, this.log);
    this.connections.set(blid, connection);

    // Create the device and register with Matterbridge
    const roombaDevice = new RoombaDevice(connection, this.log, blid);
    this.roombaDevices.set(blid, roombaDevice);

    await this.registerDevice(roombaDevice.device);
    this.log.info(`Registered Roomba device: ${connection.getDeviceName()}`);

    // Set up reconnection handler
    connection.on('disconnected', () => {
      this.log.warn(`Roomba ${blid} disconnected, will attempt reconnection...`);
      this.scheduleReconnect(blid, deviceConfig);
    });
  }

  override async onConfigure(): Promise<void> {
    this.log.info('Configuring Roomba devices...');

    // Connect to all robots and initialize state
    for (const [blid, connection] of this.connections) {
      try {
        await connection.connect();
        const device = this.roombaDevices.get(blid);
        if (device) {
          device.initializeState();
        }
        this.log.info(`Roomba ${blid} connected and configured`);
      } catch (err) {
        this.log.error(`Failed to connect to Roomba ${blid}: ${err}`);
        const config = this.platformConfig.devices?.find((d) => d.blid === blid);
        if (config) {
          this.scheduleReconnect(blid, config);
        }
      }
    }
  }

  override async onShutdown(reason?: string): Promise<void> {
    this.log.info(`Shutting down Roomba plugin (reason: ${reason ?? 'unknown'})`);

    // Clear all reconnect timers
    for (const timer of this.reconnectTimers.values()) {
      clearTimeout(timer);
    }
    this.reconnectTimers.clear();

    // Disconnect all robots
    for (const [blid, connection] of this.connections) {
      this.log.info(`Disconnecting Roomba ${blid}`);
      connection.disconnect();
    }
    this.connections.clear();
    this.roombaDevices.clear();
  }

  private scheduleReconnect(blid: string, config: RoombaDeviceConfig): void {
    // Don't schedule if already pending
    if (this.reconnectTimers.has(blid)) return;

    const timer = setTimeout(async () => {
      this.reconnectTimers.delete(blid);
      this.log.info(`Attempting to reconnect to Roomba ${blid}...`);

      const connection = this.connections.get(blid);
      if (connection) {
        try {
          await connection.connect();
          const device = this.roombaDevices.get(blid);
          if (device) {
            device.initializeState();
          }
          this.log.info(`Reconnected to Roomba ${blid}`);
        } catch (err) {
          this.log.warn(`Reconnect failed for ${blid}: ${err}`);
          this.scheduleReconnect(blid, config);
        }
      }
    }, 30_000); // Retry every 30 seconds

    this.reconnectTimers.set(blid, timer);
  }
}
