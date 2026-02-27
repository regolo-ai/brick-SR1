/**
 * Init wizard coordinator — orchestrates the 7-step setup flow.
 *
 * Uses @clack/prompts intro()/outro() to frame the entire wizard
 * session with consistent guide-lines. Each step uses clack's
 * prompts internally for a unified visual experience.
 */

import * as fs from 'node:fs'
import * as p from '@clack/prompts'
import {saveConfig} from '../config/loader.js'
import type {MyModelConfig} from '../config/schema.js'
import {ACCENT} from '../ui/theme.js'

import {showWelcome} from './steps/welcome.js'
import {promptModelIdentity} from './steps/model-identity.js'
import {promptProviders, type ProviderData} from './steps/providers.js'
import {promptTextRoutes, type TextRouteData} from './steps/text-routes.js'
import {promptModalities} from './steps/modality.js'
import {promptPlugins, type PluginsData} from './steps/plugins.js'
import {showSummary} from './steps/summary.js'

const TOTAL_STEPS = 7

export interface WizardData {
  modelName: string
  modelDesc: string
  providers: Record<string, ProviderData>
  textRoutes: TextRouteData[]
  defaultProvider: string
  defaultModel: string
  modalityRoutes: Record<string, {provider: string; model: string}>
  plugins: PluginsData
  envVars: Record<string, string>
}

/**
 * Run the full init wizard. Returns true if config was saved.
 */
export async function runInitWizard(outputPath: string): Promise<boolean> {
  try {
    // Step 1: Welcome (calls intro() internally)
    showWelcome()

    // Step 2: Model identity
    const {modelName, modelDesc} = await promptModelIdentity(TOTAL_STEPS)

    // Step 3: Providers
    const {providers, envVars} = await promptProviders(TOTAL_STEPS)

    // Step 4: Text routes
    const {textRoutes, defaultProvider, defaultModel} = await promptTextRoutes(TOTAL_STEPS, providers)

    // Step 5: Modality routes
    const modalityRoutes = await promptModalities(TOTAL_STEPS, providers)

    // Step 6: Plugins
    const plugins = await promptPlugins(TOTAL_STEPS)

    // Step 7: Summary + save
    const data: WizardData = {
      modelName, modelDesc, providers, textRoutes,
      defaultProvider, defaultModel, modalityRoutes, plugins, envVars,
    }

    const shouldSave = await showSummary(TOTAL_STEPS, data)

    if (!shouldSave) {
      p.outro('Configuration not saved.')
      return false
    }

    // Build and save config
    const config = buildConfig(data)
    saveConfig(config, outputPath)

    // Write .env.example if env vars were collected
    if (Object.keys(envVars).length > 0) {
      const envContent = Object.keys(envVars)
        .map(k => `${k}=`)
        .join('\n') + '\n'
      fs.writeFileSync('.env.example', envContent)
    }

    // Build "next steps" note
    const nextSteps = [
      `Configuration saved to ${ACCENT(outputPath)}`,
    ]
    if (Object.keys(envVars).length > 0) {
      nextSteps.push(`Created .env.example with required environment variables`)
    }
    nextSteps.push('')
    nextSteps.push('Next:')
    nextSteps.push(`  ${ACCENT('mymodel serve')}          Start the server`)
    nextSteps.push(`  ${ACCENT('mymodel config show')}    Review your config`)
    nextSteps.push(`  ${ACCENT('mymodel add provider')}   Add more providers`)

    p.note(nextSteps.join('\n'), 'Done!')
    p.outro('Happy routing!')

    return true
  } catch (error) {
    if ((error as Error).message?.includes('User force closed')) {
      p.cancel('Wizard cancelled.')
      return false
    }
    throw error
  }
}

/**
 * Build a MyModelConfig from wizard data.
 */
function buildConfig(data: WizardData): MyModelConfig {
  // Providers
  const providers: MyModelConfig['providers'] = {}
  for (const [name, prov] of Object.entries(data.providers)) {
    providers[name] = {
      type: prov.type,
      base_url: prov.base_url,
      api_key: prov.api_key,
    }
  }

  // Text routes
  const textRoutes: MyModelConfig['text_routes'] = data.textRoutes.map(r => ({
    name: r.name,
    priority: r.priority,
    signals: {
      keywords: r.keywords,
      domains: r.domains,
    },
    operator: r.operator as 'OR' | 'AND',
    provider: r.provider,
    model: r.model,
  }))

  // Add default route
  if (data.defaultProvider) {
    textRoutes.push({
      name: 'default',
      priority: 0,
      signals: {keywords: [], domains: []},
      operator: 'OR',
      provider: data.defaultProvider,
      model: data.defaultModel,
    })
  }

  // Modality routes
  const modalityRoutes: MyModelConfig['modality_routes'] = {}
  for (const [mod, route] of Object.entries(data.modalityRoutes)) {
    modalityRoutes[mod] = {provider: route.provider, model: route.model}
  }

  // Plugins
  const plugins: MyModelConfig['plugins'] = {}
  for (const [name, conf] of Object.entries(data.plugins)) {
    plugins[name] = {enabled: conf.enabled, action: conf.action}
  }

  return {
    model: {name: data.modelName, description: data.modelDesc},
    providers,
    modality_routes: modalityRoutes,
    text_routes: textRoutes,
    server: {port: 8000, cors: ''},
    plugins,
    classifier: {},
  }
}
