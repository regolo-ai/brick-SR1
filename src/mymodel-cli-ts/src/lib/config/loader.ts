/**
 * Config loader — load, save, validate config.yaml.
 * Ported from Python loader.py
 */

import * as fs from 'node:fs'
import * as yaml from 'js-yaml'
import {MyModelConfigSchema, type MyModelConfig, type ProviderEntry} from './schema.js'
import {resolveEnvVars, maskSecret} from './env-resolver.js'

/**
 * Normalize raw YAML dict into the shape MyModelConfigSchema expects.
 * Handles server_port (flat) → server.port (nested) and signal type coercion.
 */
function fromRaw(raw: Record<string, unknown>): Record<string, unknown> {
  const data = {...raw}

  // server_port (flat) → server.port (nested)
  if ('server_port' in data && !('server' in data)) {
    data.server = {port: data.server_port}
    delete data.server_port
  } else if ('server_port' in data) {
    const server = (data.server ?? {}) as Record<string, unknown>
    server.port = data.server_port
    data.server = server
    delete data.server_port
  }

  // Ensure signals in text_routes are objects
  const textRoutes = data.text_routes as Array<Record<string, unknown>> | undefined
  if (textRoutes) {
    for (const route of textRoutes) {
      if (typeof route.signals === 'string') {
        route.signals = {}
      }
    }
  }

  return data
}

/**
 * Load a MyModel config from a YAML file.
 */
export function loadConfig(path: string): MyModelConfig {
  const content = fs.readFileSync(path, 'utf8')
  const raw = (yaml.load(content) as Record<string, unknown>) ?? {}
  const normalized = fromRaw(raw)
  return MyModelConfigSchema.parse(normalized)
}

/**
 * Save a MyModel config to a YAML file.
 * Flattens server.port back to server_port for Go router compatibility.
 */
export function saveConfig(config: MyModelConfig, path: string): void {
  const data: Record<string, unknown> = {...config}

  // Flatten server.port → server_port
  const server = data.server as {port?: number; cors?: string} | undefined
  if (server) {
    data.server_port = server.port ?? 8000
    delete data.server
  }

  // Remove empty classifier
  const classifier = data.classifier as Record<string, unknown> | undefined
  if (classifier && Object.keys(classifier).length === 0) {
    delete data.classifier
  }

  // Clean up empty signal lists in text routes
  const textRoutes = data.text_routes as Array<Record<string, unknown>> | undefined
  if (textRoutes) {
    for (const route of textRoutes) {
      const signals = route.signals as Record<string, unknown> | undefined
      if (signals) {
        if (Array.isArray(signals.keywords) && signals.keywords.length === 0) {
          delete signals.keywords
        }
        if (Array.isArray(signals.domains) && signals.domains.length === 0) {
          delete signals.domains
        }
        if (Object.keys(signals).length === 0) {
          delete route.signals
        }
      }
    }
  }

  fs.writeFileSync(path, yaml.dump(data, {sortKeys: false}))
}

/**
 * Return a deep copy of config with all ${VAR} in api_keys resolved.
 */
export function resolveSecrets(config: MyModelConfig): MyModelConfig {
  const resolved = structuredClone(config)
  for (const provider of Object.values(resolved.providers)) {
    provider.api_key = resolveEnvVars(provider.api_key)
  }
  return resolved
}

/**
 * Return a config dict with api_keys masked for display.
 */
export function maskedConfig(config: MyModelConfig): MyModelConfig {
  const masked = structuredClone(config)
  for (const provider of Object.values(masked.providers)) {
    if (provider.api_key) {
      provider.api_key = maskSecret(provider.api_key)
    }
  }
  return masked
}

/**
 * Check that all providers referenced in routes actually exist.
 */
export function validateProvidersInRoutes(config: MyModelConfig): string[] {
  const errors: string[] = []
  const providerNames = new Set(Object.keys(config.providers))

  for (const route of config.text_routes) {
    if (route.provider && !providerNames.has(route.provider)) {
      errors.push(
        `Text route '${route.name}' references unknown provider '${route.provider}'`,
      )
    }
  }

  for (const [modality, modRoute] of Object.entries(config.modality_routes)) {
    if (!providerNames.has(modRoute.provider)) {
      errors.push(
        `Modality route '${modality}' references unknown provider '${modRoute.provider}'`,
      )
    }
  }

  return errors
}

/**
 * Return route names that use a given provider.
 */
export function getRoutesForProvider(config: MyModelConfig, providerName: string): string[] {
  const routes: string[] = []
  for (const route of config.text_routes) {
    if (route.provider === providerName) {
      routes.push(route.name)
    }
  }
  for (const [modality, modRoute] of Object.entries(config.modality_routes)) {
    if (modRoute.provider === providerName) {
      routes.push(`modality:${modality}`)
    }
  }
  return routes
}
