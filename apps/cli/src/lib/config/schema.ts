import { z } from 'zod';

export const ProviderSchema = z.object({
  base_url: z.string().url(),
  api_key: z.string().optional(),
}).passthrough();

export const ProviderProfileSchema = z.object({
  protocol: z.enum(['responses', 'chat_completions']).optional(),
  auth_source: z.enum(['codex_request', 'provider_env']).optional(),
  api_key_env: z.string().optional(),
  responses_path: z.string().optional(),
  chat_path: z.string().optional(),
  compact_path: z.string().optional(),
  capabilities: z.array(z.string()).optional(),
  type: z.string(),
  base_url: z.string().url(),
}).passthrough();

export const ProviderEndpointSchema = z.object({
  name: z.string(),
  provider_profile: z.string(),
  weight: z.number().default(1),
}).passthrough();

export const ThinkingModeSchema = z.enum(['off', 'low', 'medium', 'high', 'xhigh', 'max']);
export type ThinkingMode = z.infer<typeof ThinkingModeSchema>;

export const ModelConfigSchema = z.object({
  upstream_model: z.string().optional(),
  transport_capabilities: z.array(z.string()).optional(),
  // Maximum operational input tokens, after any provider output reservation.
  context_window_size: z.number().int().positive().optional(),
  preferred_endpoints: z.array(z.string()),
  reasoning_family: z.string().optional(),
  /** When set, restricts which reasoning effort values the router may inject for this model.
   *  'off' disables all reasoning injection. Empty/absent = no restriction. */
  allowed_thinking_modes: z.array(ThinkingModeSchema).optional(),
}).passthrough();

export const ReasoningFamilySchema = z.object({
  parameter: z.string(),
}).passthrough();

export const BrickSchema = z.object({
  enabled: z.boolean(),
  use_model_routing: z.boolean().optional(),
  fixed_model: z.string().optional(),
  context_window: z.object({
    enabled: z.boolean().optional(),
    k: z.number().optional(),
  }).optional(),
  stt_model: z.string().optional(),
  stt_endpoint: z.string().url().optional(),
  ocr_model: z.string().optional(),
  ocr_endpoint: z.string().url().optional(),
  vision_model: z.string().optional(),
  vision_endpoint: z.string().url().optional(),
  ocr_min_text_length: z.number().default(10),
}).passthrough();


export const SkillRouterModelSchema = z.object({
  model: z.string(),
  skill_vector: z.array(z.number().finite().min(0).max(1)).length(6),
  use_reasoning: z.boolean().optional(),
  handles_images: z.boolean().optional(),
  handles_audio: z.boolean().optional(),
  base_url: z.string().url().optional(),
  api_key: z.string().optional(),
  api_key_env: z.string().optional(),
  api_key_file: z.string().optional(),
  custom_params: z.record(z.any()).optional(),
}).passthrough();

export const SkillRouterSchema = z.object({
  enabled: z.boolean().default(true),
  knob: z.number().finite().min(-1).max(1).default(0),
  capabilities: z.array(z.string()).length(6),
  systemone: z.object({ local_path: z.string() }),
  models: z.array(SkillRouterModelSchema),
  active_models: z.array(z.string()).optional(),
}).passthrough();

export const AnthropicPassthroughSchema = z.object({
  enabled: z.boolean().optional(),
  upstream_url: z.string().optional(),
  use_model_routing: z.boolean().optional(),
  fixed_model: z.string().optional(),
  route_subagents: z.boolean().optional(),
  extra_usage_enabled: z.boolean().optional(),
  context_1m_threshold_bytes: z.number().optional(),
  context_window: z.object({ enabled: z.boolean().optional(), k: z.number().optional() }).optional(),
}).passthrough();

export const ConfigSchema = z.object({
  config_version: z.literal(2).optional(),
  codex_router: z.object({ enabled: z.boolean(), local_key_env: z.string(), timeout_seconds: z.number().optional() }).optional(),
  providers: z.record(ProviderSchema).default({}),
  brick: BrickSchema.optional(),
  server_port: z.number().default(8000),
  auto_model_name: z.string().default('brick'),
  provider_profiles: z.record(ProviderProfileSchema).default({}),
  provider_endpoints: z.array(ProviderEndpointSchema).default([]),
  default_model: z.string(),
  model_config: z.record(ModelConfigSchema).default({}),
  reasoning_families: z.record(ReasoningFamilySchema).default({}),
  skill_router: SkillRouterSchema.optional(),
  anthropic_passthrough: AnthropicPassthroughSchema.optional(),
}).passthrough();

export type BrickConfig = z.infer<typeof ConfigSchema>;
export type SkillRouter = z.infer<typeof SkillRouterSchema>;
