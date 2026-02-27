/**
 * `mymodel dashboard` — launch the web dashboard.
 */

import {Flags} from '@oclif/core'
import * as p from '@clack/prompts'
import {BaseCommand} from '../base-command.js'
import {containerStatus} from '../lib/docker/containers.js'
import {DOCKER_CONTAINER_NAME, DEFAULT_DASHBOARD_PORT} from '../lib/constants.js'
import {ACCENT} from '../lib/ui/theme.js'

export default class Dashboard extends BaseCommand {
  static summary = 'Launch the web dashboard'

  static flags = {
    port: Flags.integer({default: DEFAULT_DASHBOARD_PORT, description: 'Dashboard port'}),
  }

  async run(): Promise<void> {
    const {flags} = await this.parse(Dashboard)

    const status = containerStatus(DOCKER_CONTAINER_NAME)
    if (status !== 'running') {
      p.log.error('MyModel server is not running.')
      p.log.message('Run mymodel serve to start the server first.')
      return
    }

    const url = `http://localhost:${flags.port}`
    p.log.success(`Dashboard available at ${ACCENT(url)}`)

    // Open browser
    const {exec} = await import('node:child_process')
    const platform = process.platform
    const cmd = platform === 'darwin' ? 'open' : platform === 'win32' ? 'start' : 'xdg-open'
    exec(`${cmd} ${url}`, () => {})
  }
}
