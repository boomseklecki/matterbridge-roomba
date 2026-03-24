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
        try {
            const config = this.config;
            const configDevices = config.devices ?? [];
            this.log.info('Config devices: %d, email configured: %s', configDevices.length, config.email ? 'yes' : 'no');
            let discovered = [];
            if (config.email && config.password) {
                try {
                    const robots = await getRoombas(config.email, config.password, this.log);
                    discovered = robots.map(r => ({
                        name: r.name,
                        blid: r.blid,
                        serialNumber: r.info?.serialNum,
                        password: r.password,
                        ip: r.ip,
                        model: r.model,
                        softwareVer: r.softwareVer,
                    }));
                    this.log.info('Cloud discovery found %d robots', discovered.length);
                }
                catch (e) {
                    this.log.warn('Cloud discovery failed: %s — continuing with manual config', e.message);
                }
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
                    serialNumber: dev.serialNumber ?? existing?.serialNumber,
                    password: dev.robotpwd,
                    ip: dev.ipaddress,
                    model: existing?.model ?? 'Roomba',
                    softwareVer: existing?.softwareVer,
                    missions: dev.missions,
                    stopBehaviour: dev.stopBehaviour,
                    idleWatchInterval: dev.idleWatchInterval,
                });
            }
            this.log.info('Registering %d device(s)', mergedMap.size);
            for (const info of mergedMap.values()) {
                this.log.info('Creating device: %s (%s)', info.name, info.blid);
                try {
                    const device = new RoombaDevice(info, config, this.log);
                    this.devices.push(device);
                    await this.registerDevice(device.endpoint);
                    this.log.info('Registered device: %s', info.name);
                }
                catch (e) {
                    this.log.error('Failed to create/register device %s: %s', info.name, e.message);
                }
            }
        }
        catch (e) {
            this.log.error('onStart failed: %s', e.message);
        }
    }
    async onConfigure() {
        this.log.info('onConfigure called — %d device(s) registered', this.devices.length);
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