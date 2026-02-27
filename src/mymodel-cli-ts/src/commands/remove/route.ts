/**
 * `mymodel remove route` — remove a text route from config.
 */

import * as p from '@clack/prompts'
import {BaseCommand} from '../../base-command.js'
import {saveConfig} from '../../lib/config/loader.js'
import {requireTty} from '../../lib/ui/output.js'
import {askChoice, askConfirm} from '../../lib/ui/prompts.js'
import {ACCENT} from '../../lib/ui/theme.js'

export default class RemoveRoute extends BaseCommand {
  static summary = 'Remove a text route from your config'

  async run(): Promise<void> {
    const {flags} = await this.parse(RemoveRoute)
    requireTty()

    const config = this.loadConfigOrExit(flags.config)

    if (config.text_routes.length === 0) {
      p.log.error('No routes to remove.')
      return
    }

    p.intro(ACCENT(' remove route '))

    // Build choices with route details
    const choices = config.text_routes.map(route => ({
      name: `${route.name} → ${route.provider}/${route.model} (P${route.priority})`,
      value: route.name,
    }))

    const routeName = await askChoice('Select route to remove:', choices)

    const proceed = await askConfirm(`Remove route "${routeName}"?`)
    if (!proceed) {
      p.cancel('Cancelled.')
      return
    }

    config.text_routes = config.text_routes.filter(r => r.name !== routeName)
    saveConfig(config, flags.config)

    p.outro(`Route ${ACCENT(routeName)} removed from ${flags.config}`)
  }
}
