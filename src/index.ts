import type { PlatformConfig, PlatformMatterbridge } from 'matterbridge'

import { AnsiLogger } from 'matterbridge/logger'

import { RoombaPlatform } from './platform.js'

export default function initializePlugin(matterbridge: PlatformMatterbridge, log: AnsiLogger, config: PlatformConfig): RoombaPlatform {
  return new RoombaPlatform(matterbridge, log, config)
}
