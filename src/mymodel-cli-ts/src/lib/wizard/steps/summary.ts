/**
 * Wizard Step 7: Summary display + save confirmation.
 *
 * Uses @clack/prompts note() to replace boxen for the summary box,
 * keeping the visual consistency of the clack guide-lines.
 */

import * as p from '@clack/prompts'
import {printStep} from '../../ui/output.js'
import {askConfirm} from '../../ui/prompts.js'
import {ACCENT, ACCENT_BOLD, SUCCESS, DIM} from '../../ui/theme.js'
import type {WizardData} from '../init-wizard.js'

export async function showSummary(totalSteps: number, data: WizardData): Promise<boolean> {
  printStep(7, totalSteps, 'Summary')

  // Build summary content
  const lines: string[] = []

  // Model identity
  lines.push(ACCENT_BOLD(data.modelName))
  if (data.modelDesc) lines.push(DIM(data.modelDesc))
  lines.push('')

  // Providers
  if (Object.keys(data.providers).length > 0) {
    lines.push(ACCENT_BOLD('Providers'))
    for (const [name, prov] of Object.entries(data.providers)) {
      lines.push(`  ${name}  ${DIM(prov.type)}  ${DIM(prov.base_url)}`)
    }
    lines.push('')
  }

  // Text routes
  if (data.textRoutes.length > 0) {
    lines.push(ACCENT_BOLD('Text Routes'))
    for (const r of data.textRoutes) {
      const signals = [...r.keywords.slice(0, 2), ...r.domains.slice(0, 1)].join(', ') || '—'
      lines.push(`  ${r.name}  →  ${r.provider}/${r.model}  P${r.priority}  ${DIM(signals)}`)
    }
    lines.push('')
  }

  // Default route
  if (data.defaultProvider) {
    lines.push(`Default: ${ACCENT(data.defaultProvider)}/${data.defaultModel}`)
    lines.push('')
  }

  // Modality routes
  if (Object.keys(data.modalityRoutes).length > 0) {
    lines.push(ACCENT_BOLD('Modality Routes'))
    for (const [mod, route] of Object.entries(data.modalityRoutes)) {
      lines.push(`  ${mod}: ${route.provider}/${route.model}`)
    }
    lines.push('')
  }

  // Plugins
  const activePlugins = Object.entries(data.plugins)
    .filter(([, conf]) => conf.enabled)
    .map(([name]) => name.replace(/_/g, ' '))
  if (activePlugins.length > 0) {
    lines.push(`Plugins: ${activePlugins.map(pl => SUCCESS(pl)).join(', ')}`)
  }

  p.note(lines.join('\n'), 'Configuration Summary')

  return askConfirm('Save configuration?', true)
}
