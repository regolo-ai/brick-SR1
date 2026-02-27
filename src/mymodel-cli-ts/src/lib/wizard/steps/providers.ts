/**
 * Wizard Step 3: Backend providers.
 *
 * Uses a loop pattern since the user can add multiple providers.
 * Each prompt uses guardCancel() from our prompts wrapper.
 */

import * as p from '@clack/prompts'
import {printStep, printOk} from '../../ui/output.js'
import {askText, askChoice, askConfirm} from '../../ui/prompts.js'
import {PROVIDER_PRESETS, presetToProviderName} from '../../presets.js'
import {printTable} from '../../ui/tables.js'
import {ACCENT} from '../../ui/theme.js'

export interface ProviderData {
  type: string
  base_url: string
  api_key: string
}

export interface ProvidersResult {
  providers: Record<string, ProviderData>
  envVars: Record<string, string>
}

export async function promptProviders(totalSteps: number): Promise<ProvidersResult> {
  printStep(3, totalSteps, 'Backend Providers')

  const providers: Record<string, ProviderData> = {}
  const envVars: Record<string, string> = {}

  let addMore = true
  while (addMore) {
    // Show current providers
    if (Object.keys(providers).length > 0) {
      p.note(
        Object.entries(providers)
          .map(([name, prov]) => `${name}  ${prov.type}  ${prov.base_url}`)
          .join('\n'),
        'Current providers',
      )
    }

    // Select preset
    const presetChoices = Object.keys(PROVIDER_PRESETS).map(name => ({
      name,
      value: name,
    }))
    const presetName = await askChoice('Select a provider:', presetChoices)
    const preset = PROVIDER_PRESETS[presetName]

    let providerName: string
    let type: string
    let baseUrl: string
    let apiKey: string

    if (preset) {
      providerName = await askText('Provider name:', {default: presetToProviderName(presetName)})
      type = preset.type
      baseUrl = await askText('Base URL:', {default: preset.base_url})

      if (preset.env_var) {
        apiKey = await askText('API key:', {default: `\${${preset.env_var}}`})
        if (apiKey.startsWith('${') && apiKey.endsWith('}')) {
          const varName = apiKey.slice(2, -1)
          envVars[varName] = ''
        }
      } else {
        apiKey = await askText('API key (optional):')
      }
    } else {
      providerName = await askText('Provider name:', {required: true})
      type = 'openai-compatible'
      baseUrl = await askText('Base URL:', {required: true})
      apiKey = await askText('API key (${ENV_VAR} syntax supported):')
    }

    providers[providerName] = {type, base_url: baseUrl, api_key: apiKey}
    p.log.success(`Added provider: ${ACCENT(providerName)}`)

    addMore = await askConfirm('Add another provider?')
  }

  if (Object.keys(providers).length === 0) {
    p.log.warn('No providers added. You can add them later with mymodel add provider.')
  }

  return {providers, envVars}
}
