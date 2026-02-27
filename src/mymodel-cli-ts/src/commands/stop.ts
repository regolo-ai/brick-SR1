/**
 * `mymodel stop` — stop MyModel services.
 */

import {Command} from '@oclif/core'
import * as p from '@clack/prompts'
import {stopVllmSr} from '../lib/core.js'

export default class Stop extends Command {
  static summary = 'Stop MyModel services'

  async run(): Promise<void> {
    stopVllmSr()
    p.log.success('All services stopped.')
  }
}
