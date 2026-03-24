/**
 * Matterbridge Roomba Plugin - Entry Point
 *
 * Exposes iRobot Roomba robotic vacuum cleaners as Matter devices
 * via the Matterbridge platform.
 */

import type { PlatformConfig, PlatformMatterbridge } from 'matterbridge';
import type { AnsiLogger } from 'matterbridge/logger';
import { RoombaMatterbridgePlatform } from './platform.js';

export default function initializePlugin(
  matterbridge: PlatformMatterbridge,
  log: AnsiLogger,
  config: PlatformConfig,
): RoombaMatterbridgePlatform {
  return new RoombaMatterbridgePlatform(matterbridge, log, config);
}
