/**
 * Provider presets and domain categories.
 * Ported from Python init_wizard.py
 */

export interface ProviderPreset {
  type: string
  base_url: string
  env_var: string | null
}

export const PROVIDER_PRESETS: Record<string, ProviderPreset | null> = {
  'Regolo.ai': {
    type: 'openai-compatible',
    base_url: 'https://api.regolo.ai/v1',
    env_var: 'REGOLO_API_KEY',
  },
  'OpenAI': {
    type: 'openai-compatible',
    base_url: 'https://api.openai.com/v1',
    env_var: 'OPENAI_API_KEY',
  },
  'Anthropic': {
    type: 'anthropic',
    base_url: 'https://api.anthropic.com/v1',
    env_var: 'ANTHROPIC_API_KEY',
  },
  'Google (Gemini)': {
    type: 'openai-compatible',
    base_url: 'https://generativelanguage.googleapis.com/v1beta/openai',
    env_var: 'GOOGLE_API_KEY',
  },
  'Custom OpenAI-compatible endpoint': null,
  'Local vLLM instance': {
    type: 'openai-compatible',
    base_url: 'http://localhost:8080/v1',
    env_var: null,
  },
}

export const DOMAIN_CATEGORIES = [
  'computer_science', 'mathematics', 'physics', 'biology', 'chemistry',
  'business', 'economics', 'philosophy', 'law', 'history',
  'psychology', 'health', 'engineering', 'other',
] as const

export type DomainCategory = typeof DOMAIN_CATEGORIES[number]

/**
 * Derive a provider name from a preset name.
 */
export function presetToProviderName(presetName: string): string {
  return presetName
    .toLowerCase()
    .replace(/\./g, '')
    .replace(/\s+/g, '-')
    .split('(')[0]
    .replace(/-+$/, '')
    .replace(/^local-vllm-instance$/, 'local-vllm')
}
