/**
 * @clack/prompts wrappers for interactive CLI flows.
 *
 * Every prompt guards against cancellation with isCancel() + cancel().
 * This is a core best-practice from @clack/prompts — always check
 * if the user pressed Ctrl+C and exit gracefully.
 */

import * as p from '@clack/prompts'
import {resolveApiKey} from '../config/env-resolver.js'
import {spinner} from './spinners.js'

/* ── Cancellation guard ─────────────────────────────────── */

function guardCancel<T>(value: T | symbol): T {
  if (p.isCancel(value)) {
    p.cancel('Operation cancelled.')
    process.exit(0)
  }
  return value as T
}

/* ── Text input ─────────────────────────────────────────── */

export async function askText(
  message: string,
  options: {default?: string; required?: boolean; placeholder?: string} = {},
): Promise<string> {
  const result = guardCancel(
    await p.text({
      message,
      placeholder: options.placeholder ?? options.default ?? '',
      defaultValue: options.default,
      validate: options.required
        ? (v: string) => {
            if (!v.trim()) return 'This field is required'
          }
        : undefined,
    }),
  )
  return result.trim()
}

/* ── Single choice ──────────────────────────────────────── */

export async function askChoice<T extends string>(
  message: string,
  choices: Array<{name: string; value: T; description?: string}>,
): Promise<T> {
  const options = choices.map(c => {
    const opt: {value: string; label: string; hint?: string} = {value: c.value, label: c.name}
    if (c.description) opt.hint = c.description
    return opt
  })
  const result = guardCancel(await p.select({message, options}))
  return result as T
}

/* ── Multiple choices ───────────────────────────────────── */

export async function askMultiChoice<T extends string>(
  message: string,
  choices: Array<{name: string; value: T}>,
): Promise<T[]> {
  const options = choices.map(c => ({value: c.value as string, label: c.name}))
  const result = guardCancel(await p.multiselect({message, options, required: false}))
  return result as T[]
}

/* ── Confirmation ───────────────────────────────────────── */

export async function askConfirm(
  message: string,
  defaultValue = false,
): Promise<boolean> {
  return guardCancel(
    await p.confirm({
      message,
      initialValue: defaultValue,
    }),
  )
}

/* ── Number input ───────────────────────────────────────── */

export async function askNumber(
  message: string,
  options: {default?: number; min?: number; max?: number} = {},
): Promise<number> {
  const result = guardCancel(
    await p.text({
      message,
      placeholder: options.default?.toString() ?? '',
      defaultValue: options.default?.toString(),
      validate: (v: string) => {
        const n = Number(v)
        if (Number.isNaN(n)) return 'Please enter a number'
        if (options.min !== undefined && n < options.min) return `Must be at least ${options.min}`
        if (options.max !== undefined && n > options.max) return `Must be at most ${options.max}`
      },
    }),
  )
  return Number(result) || options.default || 0
}

/* ── Model picker with provider auto-fetch ──────────────── */

export async function pickModel(
  providerName: string,
  baseUrl: string,
  apiKey = '',
  providerType = 'openai-compatible',
): Promise<string> {
  const s = spinner()
  s.start(`Fetching models from ${providerName}...`)

  const models = await fetchProviderModels(baseUrl, apiKey, providerType)
  s.stop(models.length > 0 ? `Found ${models.length} models` : 'No models found')

  if (models.length === 0) {
    return askText(`Enter model name for ${providerName}:`, {required: true})
  }

  const choices = [
    ...models.map(m => ({name: m, value: m})),
    {name: '(enter manually)', value: '__manual__' as string},
  ]

  const selected = await askChoice(`Select model from ${providerName}:`, choices)

  if (selected === '__manual__') {
    return askText('Enter model name:', {required: true})
  }

  return selected
}

/* ── Provider model fetcher ─────────────────────────────── */

export async function fetchProviderModels(
  baseUrl: string,
  apiKey = '',
  providerType = 'openai-compatible',
  timeout = 8000,
): Promise<string[]> {
  const resolvedKey = resolveApiKey(apiKey)
  const url = baseUrl.replace(/\/+$/, '')

  const headers: Record<string, string> = {}
  if (providerType === 'anthropic') {
    headers['x-api-key'] = resolvedKey
    headers['anthropic-version'] = '2023-06-01'
  } else if (resolvedKey) {
    headers['Authorization'] = `Bearer ${resolvedKey}`
  }

  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeout)
    const resp = await fetch(`${url}/models`, {headers, signal: controller.signal})
    clearTimeout(timer)

    if (!resp.ok) return []

    const data = await resp.json() as {data?: Array<{id: string}>}
    return (data.data ?? []).map(m => m.id).sort()
  } catch {
    return []
  }
}
