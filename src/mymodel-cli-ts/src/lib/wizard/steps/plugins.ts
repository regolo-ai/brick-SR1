/**
 * Wizard Step 6: Security plugins.
 *
 * Uses group() since all three plugin prompts are sequential
 * and don't depend on each other.
 */

import * as p from '@clack/prompts'
import {printStep} from '../../ui/output.js'
import {askConfirm, askChoice} from '../../ui/prompts.js'

export interface PluginsData {
  [pluginName: string]: {enabled: boolean; action: string}
}

export async function promptPlugins(totalSteps: number): Promise<PluginsData> {
  printStep(6, totalSteps, 'Security Plugins')

  const plugins: PluginsData = {}

  // PII Detection
  const piiEnabled = await askConfirm('Enable PII detection?')
  let piiAction = ''
  if (piiEnabled) {
    piiAction = await askChoice('PII action:', [
      {name: 'redact — replace PII with [REDACTED]', value: 'redact'},
      {name: 'mask — partially mask PII', value: 'mask'},
      {name: 'block — reject request entirely', value: 'block'},
    ])
  }
  plugins.pii_detection = {enabled: piiEnabled, action: piiAction}

  // Jailbreak Guard
  const jailbreakEnabled = await askConfirm('Enable jailbreak guard?')
  plugins.jailbreak_guard = {enabled: jailbreakEnabled, action: jailbreakEnabled ? 'block' : ''}

  // Semantic Cache
  const cacheEnabled = await askConfirm('Enable semantic cache?')
  plugins.semantic_cache = {enabled: cacheEnabled, action: ''}

  return plugins
}
