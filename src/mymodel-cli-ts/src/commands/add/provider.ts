/**
 * `mymodel add provider` — add a backend provider interactively.
 *
 * Uses @clack/prompts with intro/outro framing for a polished
 * single-command interactive experience.
 */

import * as p from '@clack/prompts'
import {BaseCommand} from '../../base-command.js'
import {saveConfig} from '../../lib/config/loader.js'
import {requireTty} from '../../lib/ui/output.js'
import {askText, askChoice} from '../../lib/ui/prompts.js'
import {PROVIDER_PRESETS, presetToProviderName} from '../../lib/presets.js'
import {ACCENT} from '../../lib/ui/theme.js'

export default class AddProvider extends BaseCommand {
  static summary = 'Add a backend provider (Regolo, OpenAI, Anthropic, custom)'

  static examples = [
    '<%= config.bin %> add provider',
    '<%= config.bin %> add provider --config ./my-config.yaml',
  ]

  async run(): Promise<void> {
    const {flags} = await this.parse(AddProvider)
    requireTty()

    const config = this.loadConfigOrExit(flags.config)

    p.intro(ACCENT(' add provider '))

    // Select preset
    const presetChoices = Object.keys(PROVIDER_PRESETS).map(name => ({
      name,
      value: name,
    }))
    const presetName = await askChoice('Select a provider:', presetChoices)
    const preset = PROVIDER_PRESETS[presetName]

    // Fill fields from preset or ask manually
    let providerName: string
    let type: string
    let baseUrl: string
    let apiKey: string

    if (preset) {
      providerName = await askText('Provider name:', {default: presetToProviderName(presetName)})
      type = preset.type
      baseUrl = await askText('Base URL:', {default: preset.base_url})
      apiKey = preset.env_var
        ? await askText('API key:', {default: `\${${preset.env_var}}`})
        : await askText('API key (optional):')
    } else {
      providerName = await askText('Provider name:', {required: true})
      type = 'openai-compatible'
      baseUrl = await askText('Base URL:', {required: true})
      apiKey = await askText('API key (${ENV_VAR} syntax supported):')
    }

    // Add to config
    config.providers[providerName] = {type, base_url: baseUrl, api_key: apiKey}
    saveConfig(config, flags.config)

    p.outro(`Provider ${ACCENT(providerName)} added to ${flags.config}`)
  }
}
