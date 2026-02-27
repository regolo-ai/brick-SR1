/**
 * `mymodel generate` — legacy config generation (hidden).
 */

import {Args} from '@oclif/core'
import * as p from '@clack/prompts'
import {BaseCommand} from '../base-command.js'

export default class Generate extends BaseCommand {
  static summary = '[Legacy] Generate envoy or router config'
  static hidden = true

  static args = {
    config_type: Args.string({
      description: 'Type of config to generate',
      required: true,
      options: ['envoy', 'router'],
    }),
  }

  async run(): Promise<void> {
    const {args, flags} = await this.parse(Generate)
    p.log.warn('The generate command is deprecated. Use mymodel serve instead.')
  }
}
