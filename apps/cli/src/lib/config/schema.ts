import { z } from 'zod';

export const ConditionSchema = z.object({
  type: z.enum(['keyword', 'domain', 'complexity']),
  name: z.string(),
});

export type Condition = z.infer<typeof ConditionSchema>;
export type Rule = { operator: 'AND' | 'OR' | 'NOT'; conditions: (Rule | Condition)[] } | Condition;

export const RuleSchema: z.ZodType<Rule> = z.lazy(() =>
  z.union([
    z.object({
      operator: z.enum(['AND', 'OR', 'NOT']),
      conditions: z.array(z.union([RuleSchema, ConditionSchema])),
    }),
    ConditionSchema,
  ])
);

export const ModelRefSchema = z.object({
  model: z.string(),
  use_reasoning: z.boolean().optional(),
  reasoning_effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional(),
});

export const DecisionSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  rules: RuleSchema,
  modelRefs: z.array(ModelRefSchema).min(1),
});

export const KeywordRuleSchema = z.object({
  name: z.string(),
  operator: z.enum(['AND', 'OR']).default('OR'),
  keywords: z.array(z.string()),
  case_sensitive: z.boolean().default(false),
});

export const ProviderSchema = z.object({
  type: z.string(),
  base_url: z.string().url(),
  api_key: z.string().optional(),
});

export const ProviderProfileSchema = z.object({
  type: z.string(),
  base_url: z.string().url(),
});

export const ProviderEndpointSchema = z.object({
  name: z.string(),
  provider_profile: z.string(),
  weight: z.number().default(1),
});

export const ThinkingModeSchema = z.enum(['off', 'low', 'medium', 'high', 'xhigh', 'max']);
export type ThinkingMode = z.infer<typeof ThinkingModeSchema>;

export const ModelConfigSchema = z.object({
  preferred_endpoints: z.array(z.string()),
  param_size: z.string().optional(),
  reasoning_family: z.string().optional(),
  /** When set, restricts which reasoning effort values the router may inject for this model.
   *  'off' disables all reasoning injection. Empty/absent = no restriction. */
  allowed_thinking_modes: z.array(ThinkingModeSchema).optional(),
});

export const ReasoningFamilySchema = z.object({
  type: z.string(),
  parameter: z.string(),
});

export const ClassifierSchema = z.object({
  category_model: z.object({
    model_id: z.string(),
    use_modernbert: z.boolean().default(true),
    threshold: z.number().default(0.45),
    use_cpu: z.boolean().default(true),
    category_mapping_path: z.string().optional(),
  }),
});

export const ComplexityServiceSchema = z.object({
  enabled: z.boolean(),
  address: z.string().optional(),
  port: z.number().optional(),
  // protocol: "brick" (custom /classify, default) or "openai"
  // (/v1/chat/completions). "openai" lets a remote vLLM / hosted API serve as
  // the difficulty classifier.
  protocol: z.enum(['brick', 'openai']).optional(),
  base_url: z.string().url().optional(),
  // model_name is sent in the OpenAI request body (protocol "openai" only).
  model_name: z.string().optional(),
  // default_confidence (protocol "openai" only): confidence used when the
  // endpoint returns no usable logprobs, instead of assuming full certainty.
  default_confidence: z.number().min(0).max(1).optional(),
  bearer_token: z.string().optional(),
  bearer_token_file: z.string().optional(),
  timeout_seconds: z.number().default(5),
  auto_spawn: z.boolean().optional(),
  script_path: z.string().optional(),
  device: z.enum(['auto', 'cpu', 'cuda']).optional(),
});

export const BrickSchema = z.object({
  enabled: z.boolean(),
  use_model_routing: z.boolean().optional(),
  fixed_model: z.string().optional(),
  routing_mode: z.enum(['off', 'sticky', 'smartsqueeze', 'orchestrator']).optional(),
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
});

export const PluginSchema = z.object({
  enabled: z.boolean().default(false),
  action: z.string().optional(),
});

export const SkillRouterModelSchema = z.object({
  model: z.string(),
  skill_vector: z.array(z.number()).min(1),
  // Provenance of skill_vector: 'benchmark' (public lab benchmarks, cold-start
  // prior), 'measured' (brick skills extract on the frozen probe set), or
  // 'heuristic' (interpolated fallback for an unknown id). Ignored by the Go
  // router (unknown yaml field) but surfaced in the config and `brick status`.
  skill_source: z.enum(['benchmark', 'measured', 'heuristic']).optional(),
  skill_confidence: z.array(z.string()).optional(),
  skill_card_metadata: z.record(z.any()).optional(),
  use_reasoning: z.boolean().optional(),
  reasoning_effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional(),
  cost_weight: z.number().optional(),
  latency_weight: z.number().optional(),
  // Native multimodal capability. When set, the brick gateway forwards the raw
  // modality (image_url / audio part) straight to this model instead of running
  // OCR/STT to flatten it to text first. Honored by the Go router's capability
  // -aware passthrough (pkg/proxy/brick.go).
  handles_images: z.boolean().optional(),
  handles_audio: z.boolean().optional(),
  // Inline endpoint config — enables per-model routing to OpenRouter / Regolo /
  // Together / any OpenAI-compatible backend without provider_profiles boilerplate.
  base_url: z.string().url().optional(),
  api_key: z.string().optional(),
  api_key_env: z.string().optional(),
  api_key_file: z.string().optional(),
  custom_params: z.record(z.any()).optional(),
});

export const SkillRouterKeywordRuleSchema = z.object({
  name: z.string(),
  mode: z.enum(['override', 'bias']).default('bias'),
  importance: z.number().int().min(1).max(10).default(5),
  model: z.string().optional(),
  capability: z.string().optional(),
  bias: z.record(z.number()).optional(),
  operator: z.enum(['AND', 'OR']).default('OR'),
  keywords: z.array(z.string()).min(1),
  case_sensitive: z.boolean().default(false),
});

export const SkillRouterSchema = z.object({
  enabled: z.boolean().default(true),
  // When true the Go router derives reasoning/thinking effort per query from the
  // prompt complexity label, clamped by routing_preference (eco..max), instead of
  // the fixed per-model reasoning_effort. See apps/router pkg/proxy/effort.go.
  dynamic_effort: z.boolean().optional(),
  capabilities: z.array(z.string()).min(1),
  capability_model: z.object({
    model_id: z.string().optional(),
    repo_id: z.string().optional(),
    local_path: z.string().optional(),
    labels: z.array(z.string()).optional(),
    use_cpu: z.boolean().default(true),
  }),
  complexity_model: z.object({
    model_id: z.string().default('regolo/brick-complexity-2-eco'),
    base_model_id: z.string().default('Qwen/Qwen3.5-0.8B'),
    base_url: z.string().url().optional(),
    bearer_token: z.string().optional(),
    bearer_token_file: z.string().optional(),
    timeout_seconds: z.number().default(8),
    auto_spawn: z.boolean().optional(),
    script_path: z.string().optional(),
    device: z.enum(['auto', 'cpu', 'cuda']).optional(),
  }),
  math: z.object({
    prior_strength: z.number().default(8),
    tau: z.record(z.number()).default({ easy: 0.55, medium: 0.72, hard: 0.88 }),
    routing_preference: z.number().min(-1).max(1).default(0),
    complexity_mu: z.number().nonnegative().default(0.345170),
    complexity_bias: z.number().default(0.822235),
    cost_penalty_beta: z.number().nonnegative().default(0.230778),
    over_penalty_lambda: z.number().default(0.045207),
    preference_power: z.number().nonnegative().default(2.920351),
    max_mu_multiplier: z.number().nonnegative().default(13.034935),
    max_bias_shift: z.number().default(5.294173),
    max_cost_relief: z.number().nonnegative().default(6559.073066),
    max_over_relief: z.number().nonnegative().default(49.547940),
    min_mu_multiplier: z.number().nonnegative().default(0.081493),
    min_bias_shift: z.number().default(-1.349259),
    min_cost_boost: z.number().nonnegative().default(8.834043),
    min_over_boost: z.number().nonnegative().default(1002.068256),
    tie_epsilon: z.number().default(0.03),
    clip_min: z.number().default(0.02),
    clip_max: z.number().default(0.98),
  }),
  models: z.array(SkillRouterModelSchema).min(1),
  // Subset of `models` that is eligible for text routing. When non-empty, only
  // these models are candidates (their skill_vector enters the distance
  // computation); absent/empty means all models are candidates. The Go router
  // reads this as skill_router.active_models.
  active_models: z.array(z.string()).optional(),
  keyword_rules: z.array(SkillRouterKeywordRuleSchema).default([]),
});

// AnthropicModelMapSchema: mappa complessità → ID modello per il passthrough Anthropic.
export const AnthropicModelMapSchema = z.object({
  easy: z.string().optional(),
  medium: z.string().optional(),
  hard: z.string().optional(),
});

// AnthropicPassthroughSchema: sottoinsieme del config Go anthropic_passthrough.
// Solo i campi che il CLI configura direttamente; il resto è opaque (passthrough).
export const AnthropicPassthroughSchema = z.object({
  enabled: z.boolean().optional(),
  upstream_url: z.string().optional(),
  use_model_routing: z.boolean().optional(),
  use_thinking_routing: z.boolean().optional(),
  fixed_model: z.string().optional(),
  route_subagents: z.boolean().optional(),
  use_skill_router: z.boolean().optional(),
  extra_usage_enabled: z.boolean().optional(),
  context_1m_threshold_bytes: z.number().optional(),
  model_map: AnthropicModelMapSchema.optional(),
  model_map_1m: AnthropicModelMapSchema.optional(),
  context_window: z.object({
    enabled: z.boolean().optional(),
    k: z.number().optional(),
  }).optional(),
}).passthrough();

export const ConfigSchema = z.object({
  model: z.object({
    name: z.string(),
    description: z.string().optional(),
  }),
  providers: z.record(ProviderSchema).default({}),
  brick: BrickSchema.optional(),
  server_port: z.number().default(8000),
  auto_model_name: z.string().default('brick'),
  // Model download registry: maps a local model path (e.g.
  // "models/modernbert-capability-classifier") to its Hugging Face repo id, so the
  // Go router downloads the model on first start (see MoMRegistry in apps/router
  // pkg/config). Required whenever skill_router.enabled is true.
  //
  // Modeled explicitly so a config load -> parse -> save round-trip preserves it.
  // ConfigSchema is a plain (non-passthrough) z.object, so any top-level key it
  // does not declare is stripped by ConfigSchema.parse(); saveConfig() then dumps
  // the stripped object. Every load->save path (mode switch, `brick add/remove`,
  // `brick config edit`, config-ai edits, the wizard) would otherwise silently
  // delete mom_registry, making the router crash-loop at startup with
  // "model path models/modernbert-capability-classifier not found in mom_registry".
  mom_registry: z.record(z.string()).optional(),
  provider_profiles: z.record(ProviderProfileSchema).default({}),
  provider_endpoints: z.array(ProviderEndpointSchema).default([]),
  default_model: z.string(),
  model_config: z.record(ModelConfigSchema).default({}),
  reasoning_families: z.record(ReasoningFamilySchema).default({}),
  default_reasoning_effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).default('medium'),
  classifier: ClassifierSchema.optional(),
  complexity_service: ComplexityServiceSchema.optional(),
  skill_router: SkillRouterSchema.optional(),
  keyword_rules: z.array(KeywordRuleSchema).default([]),
  decisions: z.array(DecisionSchema).default([]),
  plugins: z.record(PluginSchema).optional(),
  anthropic_passthrough: AnthropicPassthroughSchema.optional(),
});

export type BrickConfig = z.infer<typeof ConfigSchema>;
export type Decision = z.infer<typeof DecisionSchema>;
export type ModelRef = z.infer<typeof ModelRefSchema>;
export type KeywordRuleType = z.infer<typeof KeywordRuleSchema>;
export type SkillRouter = z.infer<typeof SkillRouterSchema>;
