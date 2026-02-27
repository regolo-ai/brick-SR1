/**
 * Wizard Step 4: Text routes.
 *
 * Uses a loop for adding multiple routes and group() for
 * the default route selection at the end.
 */

import * as p from '@clack/prompts'
import {printStep} from '../../ui/output.js'
import {askText, askChoice, askMultiChoice, askNumber, askConfirm, pickModel} from '../../ui/prompts.js'
import {DOMAIN_CATEGORIES} from '../../presets.js'
import {ACCENT, DIM} from '../../ui/theme.js'

export interface TextRouteData {
  name: string
  provider: string
  model: string
  priority: number
  keywords: string[]
  domains: string[]
  operator: string
}

export interface TextRoutesResult {
  textRoutes: TextRouteData[]
  defaultProvider: string
  defaultModel: string
}

export async function promptTextRoutes(
  totalSteps: number,
  providers: Record<string, {type: string; base_url: string; api_key: string}>,
): Promise<TextRoutesResult> {
  printStep(4, totalSteps, 'Text Routes')

  const providerNames = Object.keys(providers)
  const textRoutes: TextRouteData[] = []

  if (providerNames.length === 0) {
    p.log.warn('No providers configured. Skipping routes.')
    return {textRoutes: [], defaultProvider: '', defaultModel: ''}
  }

  let addMore = await askConfirm('Add a specialized text route?')

  while (addMore) {
    // Show current routes
    if (textRoutes.length > 0) {
      p.note(
        textRoutes
          .map(r => `${r.name}  →  ${r.provider}/${r.model}  P${r.priority}`)
          .join('\n'),
        'Current routes',
      )
    }

    const name = await askText('Route name:', {required: true})

    const provider = await askChoice(
      'Provider:',
      providerNames.map(n => ({name: n, value: n})),
    )

    const prov = providers[provider]
    const model = await pickModel(provider, prov.base_url, prov.api_key, prov.type)

    const priority = await askNumber('Priority (0-100):', {default: 50, min: 0, max: 100})

    const keywordsStr = await askText('Keywords (comma-separated):')
    const keywords = keywordsStr
      ? keywordsStr.split(',').map(k => k.trim()).filter(Boolean)
      : []

    const domains = await askMultiChoice(
      'Domain triggers (optional):',
      DOMAIN_CATEGORIES.map(d => ({name: d, value: d})),
    )

    const operator = await askChoice('Signal operator:', [
      {name: 'OR — match any signal', value: 'OR' as const},
      {name: 'AND — match all signals', value: 'AND' as const},
    ])

    textRoutes.push({name, provider, model, priority, keywords, domains, operator})
    p.log.success(`Added route: ${ACCENT(name)} → ${provider}/${model}`)

    addMore = await askConfirm('Add another route?')
  }

  // Default route (fallback)
  p.log.info(ACCENT('Default route (fallback when no signals match):'))

  const defaultProvider = await askChoice(
    'Default provider:',
    providerNames.map(n => ({name: n, value: n})),
  )

  const defProv = providers[defaultProvider]
  const defaultModel = await pickModel(defaultProvider, defProv.base_url, defProv.api_key, defProv.type)

  return {textRoutes, defaultProvider, defaultModel}
}
