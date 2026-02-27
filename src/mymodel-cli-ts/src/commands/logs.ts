/**
 * `mymodel logs <service>` — show logs from a service (legacy/hidden).
 */

import {Args, Flags} from '@oclif/core'
import * as p from '@clack/prompts'
import {BaseCommand} from '../base-command.js'
import {containerLogs} from '../lib/docker/containers.js'
import {DOCKER_CONTAINER_NAME} from '../lib/constants.js'

export default class Logs extends BaseCommand {
  static summary = 'Show logs from a service'
  static hidden = true

  static args = {
    service: Args.string({
      description: 'Service to show logs for',
      required: true,
      options: ['router', 'envoy', 'dashboard'],
    }),
  }

  static flags = {
    follow: Flags.boolean({char: 'f', default: false, description: 'Follow log output'}),
  }

  async run(): Promise<void> {
    const {args, flags} = await this.parse(Logs)

    try {
      const logs = await containerLogs(DOCKER_CONTAINER_NAME, {
        follow: flags.follow,
        tail: 200,
      })
      console.log(logs)
    } catch {
      p.log.error(`Could not fetch logs for ${args.service}`)
    }
  }
}
