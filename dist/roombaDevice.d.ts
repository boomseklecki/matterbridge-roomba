import type { PlatformConfig } from 'matterbridge';
import { AnsiLogger } from 'node-ansi-logger';
import type { NamedMission } from './settings.js';
import type { MatterbridgeEndpoint } from 'matterbridge';
export interface DeviceInfo {
    name: string;
    blid: string;
    password: string;
    ip: string;
    model: string;
    softwareVer?: string;
    missions?: NamedMission[];
    stopBehaviour?: 'home' | 'pause';
    idleWatchInterval?: number;
}
export declare class RoombaDevice {
    readonly endpoint: MatterbridgeEndpoint;
    private readonly blid;
    private readonly robotpwd;
    private readonly ipaddress;
    private readonly missions;
    private readonly stopBehaviour;
    private readonly idlePollIntervalMillis;
    private readonly log;
    private currentCipherIndex;
    private _currentRoombaPromise;
    private cachedStatus;
    private lastUpdatedStatus;
    private userLastInterestedTimestamp;
    private roombaLastActiveTimestamp;
    private lastRefreshState;
    private currentPollTimeout;
    private lastPollInterval;
    private stopped;
    constructor(info: DeviceInfo, globalConfig: PlatformConfig, log: AnsiLogger);
    private selectedMissions;
    private startClean;
    private setupCommandHandlers;
    private connectedRoomba;
    private connect;
    private receiveRobotState;
    private receivedRobotStateIsComplete;
    private parseState;
    private mergeCachedStatus;
    private isEndpointActive;
    private updateEndpointAttributes;
    private toOperationalState;
    private refreshStatusForUser;
    startPolling(adhoc?: boolean): void;
    stopPolling(): void;
    disconnect(): void;
    private refreshState;
    private currentPollInterval;
    private isActive;
    private dockWhenStopped;
}
//# sourceMappingURL=roombaDevice.d.ts.map