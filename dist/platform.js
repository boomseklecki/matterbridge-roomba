import { MatterbridgeDynamicPlatform } from 'matterbridge';
import { getRoombas } from './roomba.js';
import { RoombaDevice } from './roombaDevice.js';
export class RoombaPlatform extends MatterbridgeDynamicPlatform {
    devices = [];
    constructor(matterbridge, log, config) {
        super(matterbridge, log, config);
    }
    async onStart(reason) {
        this.log.info('onStart called' + (reason ? `: ${reason}` : ''));
        const config = this.config;
        const configDevices = config.devices ?? [];
        let discovered = [];
        if (config.email && config.password) {
            const robots = await getRoombas(config.email, config.password, this.log);
            discovered = robots.map(r => ({
                name: r.name,
                blid: r.blid,
                password: r.password,
                ip: r.ip,
                model: r.model,
                softwareVer: r.softwareVer,
            }));
        }
        // Merge: manual config overrides discovered entries by blid
        const mergedMap = new Map();
        for (const d of discovered) {
            mergedMap.set(d.blid, d);
        }
        for (const dev of configDevices) {
            const existing = mergedMap.get(dev.blid);
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
            });
        }
        for (const info of mergedMap.values()) {
            const device = new RoombaDevice(info, config, this.log);
            this.devices.push(device);
            await this.registerDevice(device.endpoint);
        }
    }
    async onConfigure() {
        this.log.info('onConfigure called');
        for (const device of this.devices) {
            device.startPolling();
        }
    }
    async onShutdown(reason) {
        this.log.info('onShutdown called' + (reason ? `: ${reason}` : ''));
        for (const device of this.devices) {
            device.stopPolling();
            device.disconnect();
        }
    }
}
//# sourceMappingURL=platform.js.map