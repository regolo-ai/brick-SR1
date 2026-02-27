/**
 * `mymodel status` — show status of MyModel services.
 */

import {Command} from '@oclif/core'
import * as p from '@clack/prompts'
import {showServiceStatus} from '../lib/core.js'
import {ACCENT_BOLD} from '../lib/ui/theme.js'

export default class Status extends Command {
  static summary = 'Show status of MyModel services'

  async run(): Promise<void> {
    p.log.info(ACCENT_BOLD('MyModel Services'))
    showServiceStatus()
  }
}
