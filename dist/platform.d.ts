import type { PlatformConfig, PlatformMatterbridge } from 'matterbridge';
import { MatterbridgeDynamicPlatform } from 'matterbridge';
import { AnsiLogger, LogLevel } from 'matterbridge/logger';
export declare class RoombaPlatform extends MatterbridgeDynamicPlatform {
    private devices;
    constructor(matterbridge: PlatformMatterbridge, log: AnsiLogger, config: PlatformConfig);
    onStart(reason?: string): Promise<void>;
    onConfigure(): Promise<void>;
    onShutdown(reason?: string): Promise<void>;
    onChangeLoggerLevel(logLevel: LogLevel): Promise<void>;
    onConfigChanged(_config: PlatformConfig): Promise<void>;
}
//# sourceMappingURL=platform.d.ts.map