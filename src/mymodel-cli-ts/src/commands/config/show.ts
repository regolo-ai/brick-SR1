/**
 * `mymodel config show` — pretty-print current configuration.
 *
 * Uses @clack/prompts note() for sections and log.* for headers.
 */

import * as p from '@clack/prompts'
import {BaseCommand} from '../../base-command.js'
import {maskedConfig} from '../../lib/config/loader.js'
import {printTable} from '../../lib/ui/tables.js'
import {ACCENT, ACCENT_BOLD, DIM, SUCCESS} from '../../lib/ui/theme.js'

export default class ConfigShow extends BaseCommand {
  static summary = 'Pretty-print current configuration'
  static description = 'Display the configuration in a formatted view.'

  static examples = [
    '<%= config.bin %> config show',
    '<%= config.bin %> config show --config ./my-config.yaml',
  ]

  async run(): Promise<void> {
    const {flags} = await this.parse(ConfigShow)
    const config = this.loadConfigOrExit(flags.config)
    const masked = maskedConfig(config)

    // Overview
    const desc = config.model.description ? `"${config.model.description}"` : ''
    const overviewLines = [
      ACCENT_BOLD(`MyModel: ${config.model.name}`),
      ...(desc ? [DIM(desc)] : []),
      '',
      `Server:     http://0.0.0.0:${config.server.port}`,
      `Providers:  ${Object.keys(config.providers).length}`,
      `Routes:     ${config.text_routes.length}`,
      `Modalities: ${Object.keys(config.modality_routes).length}`,
      `Plugins:    ${Object.values(config.plugins).filter(pl => pl.enabled).length} active / ${Object.keys(config.plugins).length} total`,
    ]
    p.note(overviewLines.join('\n'), 'Overview')

    // Providers
    if (Object.keys(masked.providers).length > 0) {
      p.log.info(ACCENT_BOLD('Providers'))
      const provRows = Object.entries(masked.providers).map(([name, prov]) => {
        let host = prov.base_url
        try {
          host = new URL(prov.base_url).hostname || prov.base_url
        } catch { /* keep raw url */ }
        return [name, prov.type, host, prov.api_key || '(none)']
      })
      printTable(['Name', 'Type', 'Base URL', 'API Key'], provRows)
    }

    // Text Routes
    if (config.text_routes.length > 0) {
      p.log.info(ACCENT_BOLD('Text Routes'))
      const routeRows = [...config.text_routes]
        .sort((a, b) => b.priority - a.priority)
        .map(route => {
          const signalParts: string[] = []
          if (route.signals.keywords.length > 0) {
            signalParts.push(`kw: ${route.signals.keywords.slice(0, 4).join(', ')}`)
          }
          if (route.signals.domains.length > 0) {
            signalParts.push(`dom: ${route.signals.domains.slice(0, 3).join(', ')}`)
          }
          const signalsStr = signalParts.length > 0 ? signalParts.join('; ') : '—'
          return [
            `P${route.priority}`,
            route.name,
            `${route.provider}/${route.model}`,
            route.operator,
            signalsStr,
          ]
        })
      printTable(['Priority', 'Name', 'Target', 'Op', 'Signals'], routeRows)
    }

    // Modality Routes
    if (Object.keys(config.modality_routes).length > 0) {
      p.log.info(ACCENT_BOLD('Modality Routes'))
      const modRows = Object.entries(config.modality_routes).map(([mod, route]) => [
        mod.charAt(0).toUpperCase() + mod.slice(1),
        route.provider,
        route.model,
      ])
      printTable(['Modality', 'Provider', 'Model'], modRows)
    }

    // Plugins
    if (Object.keys(config.plugins).length > 0) {
      p.log.info(ACCENT_BOLD('Plugins'))
      const pluginRows = Object.entries(config.plugins).map(([name, conf]) => {
        const displayName = name.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
        const status = conf.enabled ? SUCCESS('ON') : DIM('OFF')
        const action = conf.enabled && conf.action ? conf.action : '—'
        return [displayName, status, action]
      })
      printTable(['Plugin', 'Status', 'Action'], pluginRows)
    }
  }
}
