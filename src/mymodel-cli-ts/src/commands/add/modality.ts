/**
 * `mymodel add modality` — configure audio/image/multimodal routing.
 */

import * as p from '@clack/prompts'
import {BaseCommand} from '../../base-command.js'
import {saveConfig} from '../../lib/config/loader.js'
import {requireTty} from '../../lib/ui/output.js'
import {askChoice, pickModel} from '../../lib/ui/prompts.js'
import {ACCENT} from '../../lib/ui/theme.js'

const MODALITY_TYPES = ['audio', 'image', 'multimodal', 'video'] as const

export default class AddModality extends BaseCommand {
  static summary = 'Configure audio/image/multimodal routing'

  static examples = [
    '<%= config.bin %> add modality',
  ]

  async run(): Promise<void> {
    const {flags} = await this.parse(AddModality)
    requireTty()

    const config = this.loadConfigOrExit(flags.config)

    const providerNames = Object.keys(config.providers)
    if (providerNames.length === 0) {
      p.log.error('No providers configured. Run mymodel add provider first.')
      this.exit(1)
    }

    p.intro(ACCENT(' add modality '))

    // Modality type
    const modality = await askChoice(
      'Select modality type:',
      MODALITY_TYPES.map(m => ({name: m, value: m})),
    )

    // Provider
    const provider = await askChoice(
      'Select provider:',
      providerNames.map(n => ({name: n, value: n})),
    )

    // Model
    const prov = config.providers[provider]
    const model = await pickModel(provider, prov.base_url, prov.api_key, prov.type)

    // Add to config
    config.modality_routes[modality] = {provider, model}
    saveConfig(config, flags.config)

    p.outro(`Modality ${ACCENT(modality)} → ${provider}/${model} added to ${flags.config}`)
  }
}
