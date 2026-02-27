/**
 * `mymodel init` — interactive wizard to create configuration.
 * Ported from Python main.py init command.
 */

import {Flags} from '@oclif/core'
import {BaseCommand} from '../base-command.js'
import {runInitWizard} from '../lib/wizard/init-wizard.js'
import {requireTty} from '../lib/ui/output.js'

export default class Init extends BaseCommand {
  static summary = 'Interactive wizard to create your MyModel configuration'

  static flags = {
    ...BaseCommand.baseFlags,
  }

  static examples = [
    '<%= config.bin %> init',
    '<%= config.bin %> init --config ./my-config.yaml',
  ]

  async run(): Promise<void> {
    const {flags} = await this.parse(Init)
    requireTty()
    await runInitWizard(flags.config)
  }
}
