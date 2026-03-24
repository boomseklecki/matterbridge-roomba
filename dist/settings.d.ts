import type { PlatformConfig } from 'matterbridge';
export type MatterbridgeRoombaConfig = PlatformConfig & {
    email?: string;
    password?: string;
    devices?: DeviceConfig[];
    idleWatchInterval?: number;
};
export interface DeviceConfig {
    name: string;
    blid: string;
    robotpwd: string;
    ipaddress: string;
    serialNumber?: string;
    missions?: NamedMission[];
    stopBehaviour?: 'home' | 'pause';
    idleWatchInterval?: number;
}
export interface NamedMission {
    name: string;
    pmap_id: string;
    user_pmapv_id: string;
    ordered?: number;
    favorite_id?: string;
    regions: {
        region_id: string;
        type: string;
        params?: {
            noAutoPasses?: boolean;
            twoPass?: boolean;
            carpetBoost?: boolean;
            vacHigh?: boolean;
            gentleMode?: number;
        };
    }[];
}
//# sourceMappingURL=settings.d.ts.map