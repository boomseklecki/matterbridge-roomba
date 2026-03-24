import { RoboticVacuumCleaner } from 'matterbridge/devices';
import dorita980 from 'dorita980';
// Numeric constants for @matter/types enums (avoids importing nested deps)
const RvcRunModeTag = { Idle: 16384, Cleaning: 16385 };
const RvcCleanModeTag = { Auto: 0, Vacuum: 16385 };
const RvcOpState = { Stopped: 0, Running: 1, Paused: 2, Error: 3, SeekingCharger: 64, Charging: 65, Docked: 66 };
const BatChargeLevel = { Ok: 0, Warning: 1, Critical: 2 };
const BatChargeState = { IsCharging: 1, IsNotCharging: 3 };
const CONNECT_TIMEOUT_MILLIS = 60_000;
const USER_INTERESTED_MILLIS = 60_000;
const AFTER_ACTIVE_MILLIS = 120_000;
const STATUS_TIMEOUT_MILLIS = 60_000;
const REFRESH_STATE_COALESCE_MILLIS = 10_000;
const ROBOT_CIPHERS = ['AES128-SHA256', 'TLS_AES_256_GCM_SHA384'];
const DEFAULT_IDLE_POLL_INTERVAL_MILLIS = 15 * 60 * 1000;
async function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
function shouldTryDifferentCipher(error) {
    const msg = error.message;
    return msg.includes('SSL') || msg.includes('ECONNRESET') || msg.includes('handshake');
}
export class RoombaDevice {
    endpoint;
    blid;
    robotpwd;
    ipaddress;
    missions;
    stopBehaviour;
    idlePollIntervalMillis;
    log;
    currentCipherIndex = 0;
    _currentRoombaPromise;
    cachedStatus = { timestamp: 0 };
    lastUpdatedStatus = {};
    userLastInterestedTimestamp = 0;
    roombaLastActiveTimestamp = 0;
    lastRefreshState = 0;
    currentPollTimeout;
    lastPollInterval = 0;
    stopped = false;
    constructor(info, globalConfig, log) {
        this.log = log;
        this.blid = info.blid;
        this.robotpwd = info.password;
        this.ipaddress = info.ip;
        this.missions = info.missions ?? [];
        this.stopBehaviour = info.stopBehaviour ?? 'home';
        const globalIdleMin = globalConfig.idleWatchInterval;
        this.idlePollIntervalMillis = ((info.idleWatchInterval ?? globalIdleMin ?? 15) * 60 * 1000) || DEFAULT_IDLE_POLL_INTERVAL_MILLIS;
        // Run modes: 1=Idle, 2=Cleaning (match MatterbridgeRvcRunModeServer's hardcoded assumptions)
        const supportedRunModes = [
            { label: 'Idle', mode: 1, modeTags: [{ value: RvcRunModeTag.Idle }] },
            { label: 'Cleaning', mode: 2, modeTags: [{ value: RvcRunModeTag.Cleaning }] },
        ];
        const supportedCleanModes = [
            { label: 'All Rooms', mode: 1, modeTags: [{ value: RvcCleanModeTag.Vacuum }] },
            ...this.missions.map((m, i) => ({
                label: m.name,
                mode: i + 2,
                modeTags: [{ value: RvcCleanModeTag.Vacuum }],
            })),
        ];
        const operationalStateList = [
            { operationalStateId: RvcOpState.Stopped },
            { operationalStateId: RvcOpState.Running },
            { operationalStateId: RvcOpState.Paused },
            { operationalStateId: RvcOpState.Error },
            { operationalStateId: RvcOpState.SeekingCharger },
            { operationalStateId: RvcOpState.Charging },
            { operationalStateId: RvcOpState.Docked },
        ];
        // RoboticVacuumCleaner constructor sets up BasicInformation and PowerSource clusters;
        // do not call createDefaultBridgedDeviceBasicInformationClusterServer or
        // createDefaultPowerSourceRechargeableBatteryClusterServer afterwards (would duplicate).
        this.endpoint = new RoboticVacuumCleaner(info.name, info.blid, 'server', 1, // currentRunMode: 1=Idle
        supportedRunModes, 1, // currentCleanMode: 1=All Rooms
        supportedCleanModes, null, null, RvcOpState.Docked, operationalStateList);
        this.setupCommandHandlers();
    }
    setupCommandHandlers() {
        this.endpoint.addCommandHandler('RvcRunMode.changeToMode', async ({ request }) => {
            const { newMode } = request;
            this.log.info('RvcRunMode.changeToMode → mode %s', newMode);
            if (newMode === 1) {
                // Idle
                this.connect(async (_error, roomba) => {
                    if (!roomba)
                        return;
                    try {
                        if (this.stopBehaviour === 'home') {
                            await roomba.pause();
                            await this.dockWhenStopped(roomba, 3000);
                        }
                        else {
                            await roomba.pause();
                        }
                        this.refreshStatusForUser();
                    }
                    catch (e) {
                        this.log.warn('RunMode Idle failed: %s', e.message);
                    }
                });
            }
            else {
                // Cleaning
                this.connect(async (_error, roomba) => {
                    if (!roomba)
                        return;
                    try {
                        if (this.cachedStatus.paused) {
                            await roomba.resume();
                        }
                        else {
                            await roomba.clean();
                        }
                        this.refreshStatusForUser();
                    }
                    catch (e) {
                        this.log.warn('RunMode Cleaning failed: %s', e.message);
                    }
                });
            }
        });
        this.endpoint.addCommandHandler('RvcCleanMode.changeToMode', async ({ request }) => {
            const { newMode } = request;
            this.log.info('RvcCleanMode.changeToMode → mode %s', newMode);
            this.connect(async (_error, roomba) => {
                if (!roomba)
                    return;
                try {
                    if (newMode === 1) {
                        await roomba.clean();
                    }
                    else {
                        const mission = this.missions[newMode - 2];
                        if (mission) {
                            await roomba.cleanRoom(mission);
                        }
                    }
                    this.refreshStatusForUser();
                }
                catch (e) {
                    this.log.warn('CleanMode command failed: %s', e.message);
                }
            });
        });
        this.endpoint.addCommandHandler('RvcOperationalState.pause', async () => {
            this.log.info('RvcOperationalState.pause');
            this.connect(async (_error, roomba) => {
                if (!roomba)
                    return;
                try {
                    await roomba.pause();
                    this.refreshStatusForUser();
                }
                catch (e) {
                    this.log.warn('pause failed: %s', e.message);
                }
            });
        });
        this.endpoint.addCommandHandler('RvcOperationalState.resume', async () => {
            this.log.info('RvcOperationalState.resume');
            this.connect(async (_error, roomba) => {
                if (!roomba)
                    return;
                try {
                    await roomba.resume();
                    this.refreshStatusForUser();
                }
                catch (e) {
                    this.log.warn('resume failed: %s', e.message);
                }
            });
        });
        this.endpoint.addCommandHandler('RvcOperationalState.goHome', async () => {
            this.log.info('RvcOperationalState.goHome');
            this.connect(async (_error, roomba) => {
                if (!roomba)
                    return;
                try {
                    await roomba.dock();
                    this.refreshStatusForUser();
                }
                catch (e) {
                    this.log.warn('goHome failed: %s', e.message);
                }
            });
        });
    }
    async connectedRoomba(attempts = 0) {
        return new Promise((resolve, reject) => {
            let connected = false;
            let failed = false;
            const roomba = dorita980.Local(this.blid, this.robotpwd, this.ipaddress, 2, {
                ciphers: ROBOT_CIPHERS[this.currentCipherIndex],
            });
            const startConnecting = Date.now();
            const timeout = setTimeout(() => {
                failed = true;
                this.log.debug('Timed out connecting to Roomba after %ims', Date.now() - startConnecting);
                roomba.end();
                reject(new Error('Connect timed out'));
            }, CONNECT_TIMEOUT_MILLIS);
            roomba.on('state', (state) => {
                this.receiveRobotState(state);
            });
            const onError = (error) => {
                this.log.debug('Connection error: %s', error.message);
                roomba.off('error', onError);
                roomba.end();
                clearTimeout(timeout);
                if (!connected) {
                    failed = true;
                    if (shouldTryDifferentCipher(error) && attempts < ROBOT_CIPHERS.length) {
                        this.currentCipherIndex = (this.currentCipherIndex + 1) % ROBOT_CIPHERS.length;
                        this.log.debug('Retrying with cipher %s', ROBOT_CIPHERS[this.currentCipherIndex]);
                        this.connectedRoomba(attempts + 1).then(resolve).catch(reject);
                    }
                    else {
                        reject(error);
                    }
                }
            };
            roomba.on('error', onError);
            this.log.debug('Connecting to Roomba...');
            const onConnect = () => {
                roomba.off('connect', onConnect);
                clearTimeout(timeout);
                if (failed)
                    return;
                connected = true;
                this.log.debug('Connected to Roomba in %ims', Date.now() - startConnecting);
                resolve({ roomba, useCount: 0 });
            };
            roomba.on('connect', onConnect);
        });
    }
    connect(callback) {
        this.log.debug('connect: have existing promise: %s', this._currentRoombaPromise ? 'yes' : 'no');
        const promise = this._currentRoombaPromise || this.connectedRoomba();
        this._currentRoombaPromise = promise;
        promise.then((holder) => {
            holder.useCount++;
            callback(null, holder.roomba).finally(() => {
                holder.useCount--;
                if (holder.useCount <= 0) {
                    this._currentRoombaPromise = undefined;
                    holder.roomba.end();
                }
            });
        }).catch((error) => {
            this._currentRoombaPromise = undefined;
            callback(error);
        });
    }
    receiveRobotState(state) {
        if (this.receivedRobotStateIsComplete(state)) {
            const parsed = this.parseState(state);
            this.mergeCachedStatus(parsed);
        }
    }
    receivedRobotStateIsComplete(state) {
        return state.batPct !== undefined && state.bin !== undefined && state.cleanMissionStatus !== undefined;
    }
    parseState(state) {
        const status = { timestamp: Date.now() };
        if (state.batPct !== undefined) {
            status.batteryLevel = state.batPct;
        }
        if (state.bin !== undefined) {
            status.binFull = state.bin.full;
        }
        if (state.cleanMissionStatus !== undefined) {
            switch (state.cleanMissionStatus.phase) {
                case 'run':
                    status.running = true;
                    status.charging = false;
                    status.docking = false;
                    break;
                case 'charge':
                case 'recharge':
                    status.running = false;
                    status.charging = true;
                    status.docking = false;
                    break;
                case 'hmUsrDock':
                case 'hmMidMsn':
                case 'hmPostMsn':
                    status.running = false;
                    status.charging = false;
                    status.docking = true;
                    break;
                case 'stop':
                case 'stuck':
                case 'evac':
                default:
                    status.running = false;
                    status.charging = false;
                    status.docking = false;
                    break;
            }
            status.paused = !status.running && state.cleanMissionStatus.cycle === 'clean';
        }
        return status;
    }
    mergeCachedStatus(status) {
        const newStatus = {
            ...this.cachedStatus,
            ...status,
            timestamp: Date.now(),
        };
        this.cachedStatus = newStatus;
        this.updateEndpointAttributes(newStatus);
        if (this.isActive()) {
            this.roombaLastActiveTimestamp = Date.now();
        }
    }
    isEndpointActive() {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return this.endpoint.construction?.status === 'active';
    }
    updateEndpointAttributes(status) {
        if (!this.isEndpointActive()) {
            this.log.debug('Endpoint not yet active, skipping attribute update');
            return;
        }
        const runMode = status.running ? 2 : 1;
        this.endpoint.updateAttribute('rvcRunMode', 'currentMode', runMode).catch((e) => {
            this.log.debug('updateAttribute rvcRunMode failed: %s', e.message);
        });
        const opState = this.toOperationalState(status);
        this.endpoint.updateAttribute('rvcOperationalState', 'operationalState', opState).catch((e) => {
            this.log.debug('updateAttribute rvcOperationalState failed: %s', e.message);
        });
        if (status.batteryLevel !== undefined) {
            const batPct = Math.min(200, status.batteryLevel * 2);
            this.endpoint.updateAttribute('powerSource', 'batPercentRemaining', batPct).catch((e) => {
                this.log.debug('updateAttribute batPercentRemaining failed: %s', e.message);
            });
            const chargeLevel = status.batteryLevel <= 10
                ? BatChargeLevel.Critical
                : status.batteryLevel <= 20
                    ? BatChargeLevel.Warning
                    : BatChargeLevel.Ok;
            this.endpoint.updateAttribute('powerSource', 'batChargeLevel', chargeLevel).catch((e) => {
                this.log.debug('updateAttribute batChargeLevel failed: %s', e.message);
            });
            const chargeState = status.charging
                ? BatChargeState.IsCharging
                : BatChargeState.IsNotCharging;
            this.endpoint.updateAttribute('powerSource', 'batChargeState', chargeState).catch((e) => {
                this.log.debug('updateAttribute batChargeState failed: %s', e.message);
            });
        }
        this.lastUpdatedStatus = { ...this.lastUpdatedStatus, ...status };
    }
    toOperationalState(status) {
        if (status.running)
            return RvcOpState.Running;
        if (status.docking)
            return RvcOpState.SeekingCharger;
        if (status.paused)
            return RvcOpState.Paused;
        if (status.charging)
            return RvcOpState.Charging;
        return RvcOpState.Docked;
    }
    refreshStatusForUser() {
        this.userLastInterestedTimestamp = Date.now();
        this.startPolling(true);
    }
    startPolling(adhoc) {
        if (this.stopped)
            return;
        const checkStatus = (adhoc) => {
            if (this.stopped)
                return;
            const now = Date.now();
            if (!adhoc || now - this.lastRefreshState > REFRESH_STATE_COALESCE_MILLIS) {
                this.lastRefreshState = now;
                if (this.currentPollTimeout) {
                    clearTimeout(this.currentPollTimeout);
                    this.currentPollTimeout = undefined;
                }
                this.refreshState(() => {
                    if (this.stopped)
                        return;
                    const interval = this.currentPollInterval();
                    this.lastPollInterval = interval;
                    this.log.debug('Next Roomba poll in %is', interval / 1000);
                    if (this.currentPollTimeout) {
                        clearTimeout(this.currentPollTimeout);
                        this.currentPollTimeout = undefined;
                    }
                    this.currentPollTimeout = setTimeout(() => checkStatus(false), interval);
                });
            }
        };
        checkStatus(adhoc ?? false);
    }
    stopPolling() {
        this.stopped = true;
        if (this.currentPollTimeout) {
            clearTimeout(this.currentPollTimeout);
            this.currentPollTimeout = undefined;
        }
    }
    disconnect() {
        if (this._currentRoombaPromise) {
            this._currentRoombaPromise.then(holder => {
                holder.roomba.end();
            }).catch(() => { });
            this._currentRoombaPromise = undefined;
        }
    }
    refreshState(callback) {
        const timeout = setTimeout(() => {
            this.log.debug('refreshState timed out');
            callback();
        }, STATUS_TIMEOUT_MILLIS);
        this.connect(async (error, roomba) => {
            if (error || !roomba) {
                clearTimeout(timeout);
                this.log.debug('refreshState connect error: %s', error?.message);
                callback();
                return;
            }
            await new Promise((resolve) => {
                const updateState = (state) => {
                    if (this.receivedRobotStateIsComplete(state)) {
                        this.receiveRobotState(state);
                        roomba.off('state', updateState);
                        clearTimeout(timeout);
                        resolve();
                        callback();
                    }
                };
                roomba.on('state', updateState);
            });
        });
    }
    currentPollInterval() {
        const timeSinceUserLastInterested = Date.now() - this.userLastInterestedTimestamp;
        if (timeSinceUserLastInterested < USER_INTERESTED_MILLIS) {
            return 5_000;
        }
        const timeSinceLastActive = Date.now() - this.roombaLastActiveTimestamp;
        if (this.isActive() || timeSinceLastActive < AFTER_ACTIVE_MILLIS) {
            return 10_000;
        }
        return this.idlePollIntervalMillis;
    }
    isActive() {
        return this.cachedStatus.running === true || this.cachedStatus.docking === true;
    }
    async dockWhenStopped(roomba, pollingInterval) {
        try {
            const state = await roomba.getRobotState(['cleanMissionStatus']);
            switch (state.cleanMissionStatus?.phase) {
                case 'stop':
                    await roomba.dock();
                    this.refreshStatusForUser();
                    break;
                case 'run':
                    await delay(pollingInterval);
                    await this.dockWhenStopped(roomba, pollingInterval);
                    break;
                default:
                    break;
            }
        }
        catch (e) {
            this.log.warn('dockWhenStopped failed: %s', e.message);
        }
    }
}
//# sourceMappingURL=roombaDevice.js.map