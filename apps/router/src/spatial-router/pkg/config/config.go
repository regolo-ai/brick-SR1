package config

import (
	"os"
)

type RouterConfig struct {
	ConfigVersion      int               `yaml:"config_version,omitempty"`
	CodexRouter        CodexRouterConfig `yaml:"codex_router,omitempty"`
	TrustedProxyHeader string            `yaml:"trusted_proxy_header,omitempty"`
	// Deprecated: hosted classifier removed in 4.0. Parsed for migration only.
	ComplexityService *LegacyComplexityServiceConfig `yaml:"complexity_service,omitempty"`
	LLMObservability  `yaml:",inline"`
	RouterOptions     `yaml:",inline"`
	ReasoningConfig   `yaml:",inline"`
	BackendModels     `yaml:",inline"`
	BrickExtension    `yaml:",inline"`
	SkillRouter       SkillRouterConfig `yaml:"skill_router,omitempty"`
}

type LLMObservability struct {
	// Prometheus endpoint configuration
	Observability ObservabilityConfig `yaml:"observability"`
}

type RouterOptions struct {
	AutoModelName             string `yaml:"auto_model_name,omitempty"`
	IncludeConfigModelsInList bool   `yaml:"include_config_models_in_list,omitempty"`
}

type BackendModels struct {
	ModelConfig       map[string]ModelParams     `yaml:"model_config"`
	DefaultModel      string                     `yaml:"default_model"`
	ProviderEndpoints []ProviderEndpoint         `yaml:"provider_endpoints"`
	ProviderProfiles  map[string]ProviderProfile `yaml:"provider_profiles,omitempty"`
}

type ReasoningConfig struct {
	// Deprecated: removed in 4.0; effort now comes from the client request or
	// skill_router.knob. Parsed for migration only.
	DefaultReasoningEffort string `yaml:"default_reasoning_effort,omitempty"`

	// Reasoning family configurations to define how different model families handle reasoning syntax
	ReasoningFamilies map[string]ReasoningFamilyConfig `yaml:"reasoning_families,omitempty"`
}

// ObservabilityConfig controls the maintained Prometheus endpoint.
type ObservabilityConfig struct {
	Metrics MetricsConfig `yaml:"metrics"`
}

type MetricsConfig struct {
	Enabled *bool `yaml:"enabled,omitempty"`
}

type ProviderEndpoint struct {
	// Name identifier for the endpoint
	Name string `yaml:"name"`

	// Address of the endpoint
	Address string `yaml:"address"`

	// Port of the endpoint
	Port int `yaml:"port"`

	// Load balancing weight for this endpoint
	Weight int `yaml:"weight,omitempty"`

	// Type of endpoint API: "openai_compatible" (default), "openai", "ollama", "huggingface", "openrouter"
	// This determines how requests are formatted and which API format to use
	// +optional
	Type string `yaml:"type,omitempty"`

	// ProviderProfileName references a named entry in provider_profiles
	// (like reasoning_family references reasoning_families).
	// When set, the profile's base_url, auth header format, and chat path
	// are used instead of address:port. Credentials are resolved from explicit profile configuration.
	// +optional
	ProviderProfileName string `yaml:"provider_profile,omitempty"`
}

type ProviderProfile struct {
	Protocol      string   `yaml:"protocol,omitempty"`
	AuthSource    string   `yaml:"auth_source,omitempty"`
	APIKeyEnv     string   `yaml:"api_key_env,omitempty"`
	ResponsesPath string   `yaml:"responses_path,omitempty"`
	CompactPath   string   `yaml:"compact_path,omitempty"`
	Capabilities  []string `yaml:"capabilities,omitempty"`
	// Type drives defaults for auth header, path, and LLMProvider mapping.
	// Values: "openai", "anthropic", "azure-openai", "bedrock", "gemini", "vertex-ai"
	Type string `yaml:"type"`

	// BaseURL is the provider's base URL (e.g., "https://api.openai.com/v1").
	// The selected transport combines it with the configured request path.
	BaseURL string `yaml:"base_url,omitempty"`

	// AuthHeader overrides the default auth header name for the type
	// (e.g., "Authorization" for openai, "api-key" for azure-openai, "x-api-key" for anthropic).
	AuthHeader string `yaml:"auth_header,omitempty"`

	// AuthPrefix overrides the default auth value prefix
	// (e.g., "Bearer" for openai, "" for azure-openai).
	AuthPrefix string `yaml:"auth_prefix,omitempty"`

	// ExtraHeaders are added to every request to this provider
	// (e.g., {"anthropic-version": "2023-06-01"}).
	ExtraHeaders map[string]string `yaml:"extra_headers,omitempty"`

	// APIVersion for Azure OpenAI — appended as ?api-version= to the chat path.
	APIVersion string `yaml:"api_version,omitempty"`

	// ChatPath overrides the default chat completion path suffix for the type.
	// When empty, the type-specific default is used (e.g., "/chat/completions" for openai).
	ChatPath string `yaml:"chat_path,omitempty"`
}

type ModelParams struct {
	UseClientKey  bool   `yaml:"use_client_key,omitempty"`
	UpstreamModel string `yaml:"upstream_model,omitempty"`
	// TransportCapabilities overrides the provider capability list for this
	// model. A nil slice inherits the provider list; an explicitly empty slice
	// declares no optional transport capabilities.
	TransportCapabilities []string `yaml:"transport_capabilities,omitempty"`
	// ContextWindowSize is the verified maximum input context used to publish
	// the virtual Codex catalog entry and to reject oversized requests.
	ContextWindowSize int `yaml:"context_window_size,omitempty"`
	// Preferred endpoints for this model (optional)
	PreferredEndpoints []string `yaml:"preferred_endpoints,omitempty"`

	// Reasoning family for this model (e.g., "deepseek", "qwen3", "gpt-oss")
	// If empty, the model doesn't support reasoning mode
	ReasoningFamily string `yaml:"reasoning_family,omitempty"`

	// Access key for authentication with the model endpoint
	// When set, router will add "Authorization: Bearer {access_key}" header to requests
	AccessKey string `yaml:"access_key,omitempty"`

	// Environment variable injected by the deployment Secret. Mutually exclusive with AccessKey.
	AccessKeyEnv string `yaml:"access_key_env,omitempty"`

	// ExternalModelIDs maps endpoint types to their model identifiers
	// This allows mapping the internal model name to different external model IDs
	// Example: {"huggingface": "meta-llama/Llama-3.1-8B-Instruct", "ollama": "llama3.1:8b"}
	// +optional
	ExternalModelIDs map[string]string `yaml:"external_model_ids,omitempty"`

	// AllowedThinkingModes declares provider-supported reasoning effort values for this model. Valid values: "off", "low", "medium", "high", "xhigh", "max".
	// "off" strips reasoning controls for providers that do not support them.
	// When nil or empty, no restriction applies (all effort levels are permitted).
	AllowedThinkingModes []string `yaml:"allowed_thinking_modes,omitempty"`
}

type ReasoningFamilyConfig struct {
	Parameter string `yaml:"parameter"` // "thinking", "enable_thinking", "reasoning_effort", etc.
}

type SkillRouterConfig struct {
	Knob      float64         `yaml:"knob,omitempty"`
	SystemOne SystemOneConfig `yaml:"systemone,omitempty"`
	Enabled   bool            `yaml:"enabled,omitempty"`

	// OverCapacityWeight scales the penalty for a model whose skill exceeds the
	// (knob-scaled) query requirement. 1.0 makes the metric symmetric (plain
	// Euclidean distance); lower values let broad, capable models compete
	// without punishing them for exceeding the request. Nil defaults to 0.25.
	// +optional
	OverCapacityWeight *float64 `yaml:"over_capacity_weight,omitempty"`

	// Capabilities fixes the vector dimension order used by model skill vectors
	// and capability classifier probabilities.
	Capabilities []string `yaml:"capabilities,omitempty"`

	// Models is the candidate set for text routing. Models used only for
	// multimodal direct forwarding can remain in model_config without being
	// listed here.
	Models []SkillRouterModelConfig `yaml:"models,omitempty"`

	// ActiveModels, when non-empty, restricts text-routing candidacy to this
	// subset of Models: a model listed in Models but absent from ActiveModels is
	// not a routing candidate (its skill_vector is excluded from the distance
	// computation). Empty/nil means every configured model is a candidate
	// (backward compatible). The multimodal passthrough path intersects this
	// with the per-request modality allowlist.
	ActiveModels []string `yaml:"active_models,omitempty"`

	// Keywords are strict routing rules. When a rule matches the latest user
	// message, the rule's model is selected without running SystemOne. Rules are
	// evaluated in file order and the first match wins.
	Keywords []SkillRouterKeywordRuleConfig `yaml:"keywords,omitempty"`

	// Deprecated: removed in 4.0. Parsed for migration only.
	KeywordRules    []LegacyKeywordRuleConfig    `yaml:"keyword_rules,omitempty"`
	CapabilityModel *LegacyCapabilityModelConfig `yaml:"capability_model,omitempty"`
	ComplexityModel *LegacyComplexityModelConfig `yaml:"complexity_model,omitempty"`
	Math            *LegacyMathConfig            `yaml:"math,omitempty"`
	DynamicEffort   bool                         `yaml:"dynamic_effort,omitempty"`
}

// SkillRouterKeywordRuleConfig is a strict override: a matched rule forces the
// named model instead of scoring candidates.
type SkillRouterKeywordRuleConfig struct {
	Name          string   `yaml:"name"`
	Keywords      []string `yaml:"keywords"`
	Model         string   `yaml:"model"`
	Operator      string   `yaml:"operator,omitempty"`
	CaseSensitive bool     `yaml:"case_sensitive,omitempty"`
}

type SystemOneConfig struct {
	LocalPath string `yaml:"local_path,omitempty"`
}

// DefaultOverCapacityWeight is used when skill_router.over_capacity_weight is
// unset. It keeps a fully capable model competitive without letting it win on
// raw magnitude alone.
const DefaultOverCapacityWeight = 0.25

// EffectiveOverCapacityWeight returns the configured over-capacity penalty
// weight, falling back to DefaultOverCapacityWeight when unset.
func (c SkillRouterConfig) EffectiveOverCapacityWeight() float64 {
	if c.OverCapacityWeight == nil {
		return DefaultOverCapacityWeight
	}
	return *c.OverCapacityWeight
}

type SkillRouterModelConfig struct {
	UseClientKey bool   `yaml:"use_client_key,omitempty"`
	Model        string `yaml:"model"`

	// SkillVector must follow SkillRouterConfig.Capabilities order.
	SkillVector []float64 `yaml:"skill_vector,omitempty"`

	// Native multimodal capability. When set, the brick gateway forwards the raw
	// modality (image_url / audio part) directly to this model instead of
	// flattening it to text via OCR/STT. See pkg/proxy/brick.go passthrough.
	HandlesImages bool `yaml:"handles_images,omitempty"`
	HandlesAudio  bool `yaml:"handles_audio,omitempty"`

	// Inline endpoint config. When BaseURL is set, the proxy forwards to it
	// directly instead of the legacy regoloai provider. Enables OpenRouter,
	// Together, Anyscale, or any OpenAI-compatible backend per-model.
	BaseURL    string `yaml:"base_url,omitempty"`
	APIKey     string `yaml:"api_key,omitempty"`
	APIKeyEnv  string `yaml:"api_key_env,omitempty"`
	APIKeyFile string `yaml:"api_key_file,omitempty"`

	// CustomParams are merged into the request body before forward. Values
	// already present in the client request are NOT overwritten.
	CustomParams map[string]interface{} `yaml:"custom_params,omitempty"`

	// Deprecated: removed in 4.0. Parsed for migration only.
	CostWeight      float64 `yaml:"cost_weight,omitempty"`
	ReasoningEffort string  `yaml:"reasoning_effort,omitempty"`

	ModelReasoningControl `yaml:",inline"`
}

// ResolveAPIKey returns the effective API key for this model. Priority:
//  1. APIKey literal (with $VAR expansion)
//  2. APIKeyEnv (lookup os.Getenv)
//  3. APIKeyFile (trimmed contents)
//  4. fallback, but only when no explicit source is configured
//
// An invalid explicit source stops resolution; it never falls through.
func (m *SkillRouterModelConfig) ResolveAPIKey(fallback string) string {
	if m.APIKey != "" {
		key, _ := expandCredential(m.APIKey)
		return key
	}
	if m.APIKeyEnv != "" {
		key, _ := ResolveCredentialEnv(m.APIKeyEnv)
		return key
	}
	if m.APIKeyFile != "" {
		if data, err := os.ReadFile(m.APIKeyFile); err == nil {
			key, _ := ValidateCredential(string(data))
			return key
		}
	}
	if m.HasExplicitAPIKeySource() {
		return ""
	}
	return fallback
}

func (m *SkillRouterModelConfig) HasExplicitAPIKeySource() bool {
	return m != nil && (m.APIKey != "" || m.APIKeyEnv != "" || m.APIKeyFile != "")
}

type ModelReasoningControl struct {
	UseReasoning *bool `yaml:"use_reasoning"` // Pointer to detect missing field
}
