/**
 * Wizard Step 5: Modality routes (audio, image, multimodal).
 */

import * as p from '@clack/prompts'
import {printStep} from '../../ui/output.js'
import {askChoice, askConfirm, pickModel} from '../../ui/prompts.js'

export interface ModalityRoutesData {
  [modality: string]: {provider: string; model: string}
}

const MODALITIES = ['audio', 'image', 'multimodal'] as const

export async function promptModalities(
  totalSteps: number,
  providers: Record<string, {type: string; base_url: string; api_key: string}>,
): Promise<ModalityRoutesData> {
  printStep(5, totalSteps, 'Modality Routes')

  const providerNames = Object.keys(providers)
  const modalityRoutes: ModalityRoutesData = {}

  if (providerNames.length === 0) {
    p.log.warn('No providers configured. Skipping modality routes.')
    return modalityRoutes
  }

  for (const modality of MODALITIES) {
    const enable = await askConfirm(`Enable ${modality} routing?`)
    if (!enable) continue

    const provider = await askChoice(
      `${modality} provider:`,
      providerNames.map(n => ({name: n, value: n})),
    )

    const prov = providers[provider]
    const model = await pickModel(provider, prov.base_url, prov.api_key, prov.type)

    modalityRoutes[modality] = {provider, model}
    p.log.success(`${modality} → ${provider}/${model}`)
  }

  return modalityRoutes
}
