/**
 * Matterbridge Roomba Plugin - Entry Point
 *
 * Exposes iRobot Roomba robotic vacuum cleaners as Matter devices
 * via the Matterbridge platform.
 */
import { RoombaMatterbridgePlatform } from './platform.js';
export default function initializePlugin(matterbridge, log, config) {
    return new RoombaMatterbridgePlatform(matterbridge, log, config);
}
//# sourceMappingURL=module.js.map