/**
 * Zod schemas for MyModel configuration.
 * Ported from Python Pydantic models in loader.py
 */

import {z} from 'zod'

export const ModelIdentitySchema = z.object({
  name: z.string().default('MyModel'),
  description: z.string().default(''),
})

export const ProviderEntrySchema = z.object({
  type: z.string().default('openai-compatible'),
  base_url: z.string().default(''),
  api_key: z.string().default(''),
})

export const ModalityRouteSchema = z.object({
  provider: z.string(),
  model: z.string(),
})

export const TextRouteSignalsSchema = z.object({
  keywords: z.array(z.string()).default([]),
  domains: z.array(z.string()).default([]),
}).passthrough()

export const TextRouteSchema = z.object({
  name: z.string(),
  priority: z.number().int().default(50),
  signals: TextRouteSignalsSchema.default({}),
  operator: z.enum(['OR', 'AND']).default('OR'),
  provider: z.string().default(''),
  model: z.string().default(''),
})

export const PluginConfigSchema = z.object({
  enabled: z.boolean().default(false),
  action: z.string().default(''),
}).passthrough()

export const ServerConfigSchema = z.object({
  port: z.number().int().default(8000),
  cors: z.preprocess(
    (v) => {
      if (v === true) return '*'
      if (v === false) return ''
      return v
    },
    z.string().default(''),
  ),
})

export const ClassifierConfigSchema = z.object({}).passthrough()

export const MyModelConfigSchema = z.object({
  model: ModelIdentitySchema.default({}),
  providers: z.record(z.string(), ProviderEntrySchema).default({}),
  modality_routes: z.record(z.string(), ModalityRouteSchema).default({}),
  text_routes: z.array(TextRouteSchema).default([]),
  server: ServerConfigSchema.default({}),
  plugins: z.record(z.string(), PluginConfigSchema).default({}),
  classifier: ClassifierConfigSchema.default({}),
}).passthrough() // Allow extra keys (vLLM SR-specific: decisions, categories, etc.)

// Inferred types
export type ModelIdentity = z.infer<typeof ModelIdentitySchema>
export type ProviderEntry = z.infer<typeof ProviderEntrySchema>
export type ModalityRoute = z.infer<typeof ModalityRouteSchema>
export type TextRouteSignals = z.infer<typeof TextRouteSignalsSchema>
export type TextRoute = z.infer<typeof TextRouteSchema>
export type PluginConfig = z.infer<typeof PluginConfigSchema>
export type ServerConfig = z.infer<typeof ServerConfigSchema>
export type MyModelConfig = z.infer<typeof MyModelConfigSchema>
