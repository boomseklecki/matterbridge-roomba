/**
 * Matterbridge platform for iRobot Roomba vacuum cleaners.
 */

import {
  MatterbridgeDynamicPlatform,
  type PlatformConfig,
  type PlatformMatterbridge,
} from 'matterbridge';
import type { AnsiLogger } from 'matterbridge/logger';
import { RoombaConnection, type DiscoveredMap, type RoombaDeviceConfig } from './roombaConnection.js';

interface RoomsInMissionPayload {
  pmapId: string;
  userPmapvId?: string;
  command?: string;
  selectAll: boolean;
  regions: Array<{ regionId: string; type: string; params?: Record<string, unknown> }>;
  newRegionIds: string[];
  time?: number;
}
import { RoombaDevice } from './roombaDevice.js';

interface RoombaPlatformConfig extends PlatformConfig {
  devices?: RoombaDeviceConfig[];
}

export class RoombaMatterbridgePlatform extends MatterbridgeDynamicPlatform {
  private readonly connections: Map<string, RoombaConnection> = new Map();
  private readonly roombaDevices: Map<string, RoombaDevice> = new Map();
  private readonly platformConfig: RoombaPlatformConfig;
  private reconnectTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private reconnectAttempts: Map<string, number> = new Map();
  private shuttingDown = false;

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

    // Create the device with room definitions from config (empty array suppresses defaults).
    // Default to server mode ('server') — Apple Home / Google Home handle standalone RVC
    // better than bridged RVC. Users can set serverMode:false to fold it into the bridge.
    const serverMode = deviceConfig.serverMode ?? true;
    const roombaDevice = new RoombaDevice(connection, this.log, blid, deviceConfig.rooms, serverMode);
    this.roombaDevices.set(blid, roombaDevice);
    this.log.info(
      `[${deviceConfig.name ?? blid}] Exposing robot in ${serverMode ? 'server (standalone Matter device)' : 'bridged (under Matterbridge aggregator)'} mode`,
    );

    // Try to pre-populate device identity (vendor/model/firmware) from the robot itself.
    // Falls back to config-provided values if the robot is unreachable or slow to respond —
    // we don't want plugin startup to hang indefinitely on the network.
    const vendorName = deviceConfig.vendor ?? 'iRobot';
    const FALLBACK_INFO = {
      name: deviceConfig.name ?? blid,
      sku: deviceConfig.model ?? 'Roomba',
      softwareVer: 'unknown',
      hardwareVer: 'unknown',
    };
    try {
      await withTimeout(connection.connect(), 15_000, 'connect timeout');
      const info = await withTimeout(connection.fetchIdentity(), 8_000, 'identity fetch timeout');
      roombaDevice.applyIdentity(info, vendorName, deviceConfig.model);
    } catch (err) {
      this.log.warn(
        `Could not pre-fetch identity for ${blid} (${err}); using config fallbacks.`,
      );
      roombaDevice.applyIdentity(FALLBACK_INFO, vendorName, deviceConfig.model);
    }

    await this.registerDevice(roombaDevice.device);
    this.log.info(`Registered Roomba device: ${connection.getDeviceName()}`);

    // In server mode, matterbridge stamped its own version onto the root node. Overwrite
    // with the robot's real firmware now that the server is up.
    await roombaDevice.overrideRootNodeIdentity();

    // Set up reconnection handler
    connection.on('disconnected', () => {
      this.log.warn(`Roomba ${blid} disconnected, will attempt reconnection...`);
      this.scheduleReconnect(blid, deviceConfig);
    });

    // Discovery mode: log copy-paste-ready rooms config whenever a new region is seen.
    if (deviceConfig.discoverRooms) {
      const label = deviceConfig.name ?? blid;
      this.log.info(
        `[${label}] Room discovery mode is ON. ` +
          `Clean rooms ONE AT A TIME from the iRobot app — each mission will be logged ` +
          `with its region id and timestamp so you can tell which room is which.`,
      );
      connection.on('roomsInMission', (mission: RoomsInMissionPayload) => {
        this.logMission(label, mission);
      });
      connection.on('roomsDiscovered', (maps: DiscoveredMap[]) => {
        this.logDiscoveredRooms(label, maps);
      });
    }
  }

  /** Log a single mission as it arrives so users can correlate id -> physical room. */
  private logMission(deviceLabel: string, mission: RoomsInMissionPayload): void {
    const ids = mission.regions.map((r) => `${r.regionId}${r.type !== 'rid' ? `(${r.type})` : ''}`).join(', ');
    const newSuffix = mission.newRegionIds.length > 0 ? ` (NEW: ${mission.newRegionIds.join(', ')})` : '';
    const ts = mission.time ? new Date(mission.time * 1000).toLocaleTimeString() : 'unknown';
    this.log.info(
      `[${deviceLabel}] Mission "${mission.command ?? 'start'}" at ${ts}: ` +
        `${mission.selectAll ? 'whole home' : `regions=[${ids}]`}${newSuffix}. ` +
        `(If you just cleaned a single room in the iRobot app, region ${ids} = that room.)`,
    );
  }

  /**
   * Pretty-print the accumulated room discoveries in a form the user can drop straight
   * into the plugin config under `rooms`. Named regions keep type `rid`; everything else
   * is labelled a placeholder so the user knows to rename it.
   */
  private logDiscoveredRooms(deviceLabel: string, maps: DiscoveredMap[]): void {
    for (const map of maps) {
      const lines: string[] = [];
      lines.push(`[${deviceLabel}] Discovered ${map.regions.length} room(s) on map ${map.pmapId}:`);
      lines.push(`  "rooms": [`);
      map.regions.forEach((region, i) => {
        const comma = i === map.regions.length - 1 ? '' : ',';
        // Roomba region IDs are strings — usually "1", "2", etc. but not guaranteed.
        // Matter's areaId is uint32, so numeric-parse when possible, else hash.
        const areaId = toAreaId(region.regionId);
        lines.push(
          `    { "areaId": ${areaId}, "name": "Room ${region.regionId} (rename me)", "type": null }${comma}`,
        );
      });
      lines.push(`  ]`);
      lines.push(
        `  pmapId=${map.pmapId}${map.userPmapvId ? ` userPmapvId=${map.userPmapvId}` : ''}`,
      );
      this.log.info(lines.join('\n'));
    }
  }

  override async onConfigure(): Promise<void> {
    this.log.info('Configuring Roomba devices...');

    // Mark devices active so state can be pushed to Matter attributes.
    // Connection may already have been established during onStart for identity pre-fetch;
    // if so, we just reuse it. Otherwise, attempt to (re)connect.
    for (const [blid, connection] of this.connections) {
      try {
        if (!connection.isConnected()) {
          await connection.connect();
        }
        const device = this.roombaDevices.get(blid);
        if (device) {
          device.markActive();
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
    this.shuttingDown = true;

    // Clear all reconnect timers
    for (const timer of this.reconnectTimers.values()) {
      clearTimeout(timer);
    }
    this.reconnectTimers.clear();
    this.reconnectAttempts.clear();

    // Disconnect all robots
    for (const [blid, connection] of this.connections) {
      this.log.info(`Disconnecting Roomba ${blid}`);
      connection.disconnect();
    }
    this.connections.clear();
    this.roombaDevices.clear();
  }

  private scheduleReconnect(blid: string, config: RoombaDeviceConfig): void {
    if (this.shuttingDown) return;
    // Don't schedule if already pending
    if (this.reconnectTimers.has(blid)) return;

    // Exponential backoff: 30s, 60s, 120s, 240s, capped at 600s
    const attempts = (this.reconnectAttempts.get(blid) ?? 0) + 1;
    this.reconnectAttempts.set(blid, attempts);
    const delayMs = Math.min(30_000 * 2 ** (attempts - 1), 600_000);
    this.log.info(`Scheduling reconnect #${attempts} for Roomba ${blid} in ${Math.round(delayMs / 1000)}s`);

    const timer = setTimeout(async () => {
      this.reconnectTimers.delete(blid);
      if (this.shuttingDown) return;
      this.log.info(`Attempting to reconnect to Roomba ${blid}...`);

      const connection = this.connections.get(blid);
      if (connection) {
        try {
          await connection.connect();
          const device = this.roombaDevices.get(blid);
          if (device) {
            device.initializeState();
          }
          this.reconnectAttempts.delete(blid);
          this.log.info(`Reconnected to Roomba ${blid}`);
        } catch (err) {
          this.log.warn(`Reconnect failed for ${blid}: ${err}`);
          this.scheduleReconnect(blid, config);
        }
      }
    }, delayMs);

    this.reconnectTimers.set(blid, timer);
  }
}

/**
 * Convert a Roomba `region_id` string to a stable Matter `areaId` (uint32).
 * - Numeric strings ("1", "2", …) → parsed as-is so the number stays recognisable.
 * - Anything else → FNV-1a hash clamped to 31 bits to stay safely within uint32.
 */
function toAreaId(regionId: string): number {
  const asNumber = Number(regionId);
  if (Number.isInteger(asNumber) && asNumber >= 0 && asNumber <= 0x7fffffff) {
    return asNumber;
  }
  // FNV-1a 32-bit for non-numeric region ids (some older pmaps use UUIDs)
  let hash = 0x811c9dc5;
  for (let i = 0; i < regionId.length; i++) {
    hash ^= regionId.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash & 0x7fffffff || 1;
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} after ${ms}ms`)), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}
