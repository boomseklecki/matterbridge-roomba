import type { PlatformConfig, PlatformMatterbridge } from 'matterbridge';
import { MatterbridgeDynamicPlatform } from 'matterbridge';
import { AnsiLogger } from 'node-ansi-logger';
export declare class RoombaPlatform extends MatterbridgeDynamicPlatform {
    private devices;
    constructor(matterbridge: PlatformMatterbridge, log: AnsiLogger, config: PlatformConfig);
    onStart(reason?: string): Promise<void>;
    onConfigure(): Promise<void>;
    onShutdown(reason?: string): Promise<void>;
}
//# sourceMappingURL=platform.d.ts.map