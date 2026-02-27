/**
 * `mymodel add route` — add a text routing rule interactively.
 */

import * as p from '@clack/prompts'
import {BaseCommand} from '../../base-command.js'
import {saveConfig} from '../../lib/config/loader.js'
import {requireTty} from '../../lib/ui/output.js'
import {askText, askChoice, askMultiChoice, askNumber, pickModel} from '../../lib/ui/prompts.js'
import {DOMAIN_CATEGORIES} from '../../lib/presets.js'
import {ACCENT} from '../../lib/ui/theme.js'

export default class AddRoute extends BaseCommand {
  static summary = 'Add a text routing rule'

  static examples = [
    '<%= config.bin %> add route',
  ]

  async run(): Promise<void> {
    const {flags} = await this.parse(AddRoute)
    requireTty()

    const config = this.loadConfigOrExit(flags.config)

    const providerNames = Object.keys(config.providers)
    if (providerNames.length === 0) {
      p.log.error('No providers configured. Run mymodel add provider first.')
      this.exit(1)
    }

    p.intro(ACCENT(' add route '))

    // Route name
    const name = await askText('Route name:', {required: true})

    // Provider selection
    const provider = await askChoice(
      'Select provider:',
      providerNames.map(n => ({name: n, value: n})),
    )

    // Model selection
    const prov = config.providers[provider]
    const model = await pickModel(provider, prov.base_url, prov.api_key, prov.type)

    // Priority
    const priority = await askNumber('Priority (0-100):', {default: 50, min: 0, max: 100})

    // Keywords
    const keywordsStr = await askText('Keywords (comma-separated, optional):')
    const keywords = keywordsStr
      ? keywordsStr.split(',').map(k => k.trim()).filter(Boolean)
      : []

    // Domains
    const domains = await askMultiChoice(
      'Select domain triggers (optional):',
      DOMAIN_CATEGORIES.map(d => ({name: d, value: d})),
    )

    // Operator
    const operator = await askChoice('Signal operator:', [
      {name: 'OR — match any signal', value: 'OR' as const},
      {name: 'AND — match all signals', value: 'AND' as const},
    ])

    // Add to config
    config.text_routes.push({
      name,
      priority,
      signals: {keywords, domains},
      operator,
      provider,
      model,
    })

    saveConfig(config, flags.config)
    p.outro(`Route ${ACCENT(name)} → ${provider}/${model} added to ${flags.config}`)
  }
}
