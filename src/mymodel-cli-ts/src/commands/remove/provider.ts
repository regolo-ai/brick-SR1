/**
 * `mymodel remove provider` — remove a provider from config.
 */

import * as p from '@clack/prompts'
import {BaseCommand} from '../../base-command.js'
import {saveConfig, getRoutesForProvider} from '../../lib/config/loader.js'
import {requireTty} from '../../lib/ui/output.js'
import {askChoice, askConfirm} from '../../lib/ui/prompts.js'
import {ACCENT} from '../../lib/ui/theme.js'

export default class RemoveProvider extends BaseCommand {
  static summary = 'Remove a provider from your config'

  async run(): Promise<void> {
    const {flags} = await this.parse(RemoveProvider)
    requireTty()

    const config = this.loadConfigOrExit(flags.config)

    const providerNames = Object.keys(config.providers)
    if (providerNames.length === 0) {
      p.log.error('No providers to remove.')
      return
    }

    p.intro(ACCENT(' remove provider '))

    // Select provider
    const provider = await askChoice(
      'Select provider to remove:',
      providerNames.map(n => ({name: n, value: n})),
    )

    // Check for orphaned routes
    const orphanedRoutes = getRoutesForProvider(config, provider)
    if (orphanedRoutes.length > 0) {
      p.log.warn(`These routes use "${provider}" and will be orphaned:`)
      for (const route of orphanedRoutes) {
        p.log.warn(`  ${route}`)
      }
      const proceed = await askConfirm('Remove provider anyway?')
      if (!proceed) {
        p.cancel('Cancelled.')
        return
      }
    }

    // Remove
    delete config.providers[provider]
    saveConfig(config, flags.config)

    p.outro(`Provider ${ACCENT(provider)} removed from ${flags.config}`)
  }
}
