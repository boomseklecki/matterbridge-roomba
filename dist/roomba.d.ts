export interface Logger {
    info(message: string, ...args: unknown[]): void;
    error(message: string, ...args: unknown[]): void;
    warn(message: string, ...args: unknown[]): void;
    debug(message: string, ...args: unknown[]): void;
}
export declare function getRoombas(email: string, password: string, log: Logger): Promise<Robot[]>;
export interface Robot {
    name: string;
    blid: string;
    sku?: string;
    password: string;
    ip: string;
    model: string;
    multiRoom: boolean;
    softwareVer?: string;
    info: DeviceInfo;
}
export interface DeviceInfo {
    serialNum?: string;
    ver?: string;
    hostname?: string;
    robotname?: string;
    robotid?: string;
    mac?: string;
    sw: string;
    sku?: string;
    nc?: number;
    proto?: string;
    cap?: object;
}
//# sourceMappingURL=roomba.d.ts.map