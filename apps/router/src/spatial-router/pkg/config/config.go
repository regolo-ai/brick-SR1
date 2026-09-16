package config

import (
	"fmt"
	"os"
)

type RouterConfig struct {
	ConfigVersion      int               `yaml:"config_version,omitempty"`
	CodexRouter        CodexRouterConfig `yaml:"codex_router,omitempty"`
	TrustedProxyHeader string            `yaml:"trusted_proxy_header,omitempty"`
	LLMObservability   `yaml:",inline"`
	RouterOptions      `yaml:",inline"`
	IntelligentRouting `yaml:",inline"`
	BackendModels      `yaml:",inline"`
	BrickExtension     `yaml:",inline"`
	SkillRouter        SkillRouterConfig `yaml:"skill_router,omitempty"`
}

type LLMObservability struct {
	// Prometheus endpoint configuration
	Observability ObservabilityConfig `yaml:"observability"`
}

type RouterOptions struct {
	AutoModelName             string `yaml:"auto_model_name,omitempty"`
	IncludeConfigModelsInList bool   `yaml:"include_config_models_in_list,omitempty"`
}

type IntelligentRouting struct {
	Signals         `yaml:",inline"`
	ReasoningConfig `yaml:",inline"`
}

type Signals struct {
	ComplexityService *ComplexityServiceConfig `yaml:"complexity_service,omitempty"`
}

type BackendModels struct {
	ModelConfig       map[string]ModelParams     `yaml:"model_config"`
	DefaultModel      string                     `yaml:"default_model"`
	ProviderEndpoints []ProviderEndpoint         `yaml:"provider_endpoints"`
	ProviderProfiles  map[string]ProviderProfile `yaml:"provider_profiles,omitempty"`
}

type ReasoningConfig struct {
	// Default reasoning effort level (low, medium, high) when not specified per category
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

	// AllowedThinkingModes restricts which reasoning effort values the router may inject at
	// runtime for this model. Valid values: "off", "low", "medium", "high", "xhigh", "max".
	// "off" disables all reasoning injection regardless of query difficulty.
	// When nil or empty, no restriction applies (all effort levels are permitted).
	AllowedThinkingModes []string `yaml:"allowed_thinking_modes,omitempty"`
}

type ReasoningFamilyConfig struct {
	Parameter string `yaml:"parameter"` // "thinking", "enable_thinking", "reasoning_effort", etc.
}

type ComplexityServiceConfig struct {
	// UseClientKey authenticates each classifier call with the current request credential.
	UseClientKey   bool `yaml:"use_client_key,omitempty"`
	Enabled        bool `yaml:"enabled"`
	TimeoutSeconds int  `yaml:"timeout_seconds,omitempty"` // Default: 5

	// BaseURL is the required classifier API endpoint.
	// Use it to point at a remote bearer-protected endpoint, e.g.
	// "http://127.0.0.1:18094" (SSH tunnel) or "https://classifier.example.com".
	BaseURL string `yaml:"base_url,omitempty"`

	// BearerToken is the literal token value sent as `Authorization: Bearer ...`.
	// Prefer BearerTokenFile to keep the token out of the YAML.
	BearerToken string `yaml:"bearer_token,omitempty"`

	// BearerTokenFile is the path to a file whose trimmed contents are the
	// bearer token. Read once at classifier construction time.
	BearerTokenFile string `yaml:"bearer_token_file,omitempty"`

	// Protocol selects how the router talks to the classifier:
	//   - "brick" (default, or empty): the custom POST /classify endpoint
	//     exposed by a configured API (returns {label, confidence}).
	//   - "openai": an OpenAI-compatible POST /v1/chat/completions endpoint.
	//     The router sends the complexity SYSTEM_PROMPT plus the query, reads
	//     the label from the completion text, and derives confidence from
	//     token logprobs when present. Lets a remote vLLM / hosted API act as
	//     the difficulty classifier without the brick custom protocol.
	Protocol string `yaml:"protocol,omitempty"`

	// ModelName is the model identifier sent in the OpenAI request body
	// (Protocol="openai" only). Ignored by the brick protocol.
	ModelName string `yaml:"model_name,omitempty"`

	// DefaultConfidence is the confidence used by the OpenAI protocol when the
	// endpoint returns no usable token logprobs (so the router cannot derive a
	// calibrated confidence over easy/medium/hard). The router blends the label
	// toward "medium" by this amount: tau = c*tau_label + (1-c)*tau_medium, so a
	// value near 1.0 fully trusts the label and a value near 0.5 hedges. Without
	// this the router would assume full certainty (1.0) and overstate the label.
	// Pointer so an absent field is distinguishable from 0.0. Default 0.5.
	// Ignored by the brick protocol and when logprobs are available.
	DefaultConfidence *float64 `yaml:"default_confidence,omitempty"`
}

type SkillRouterConfig struct {
	Enabled bool `yaml:"enabled,omitempty"`

	// Capabilities fixes the vector dimension order used by model skill vectors
	// and capability classifier probabilities.
	Capabilities []string `yaml:"capabilities,omitempty"`

	CapabilityModel SkillRouterCapabilityModelConfig `yaml:"capability_model,omitempty"`
	ComplexityModel SkillRouterComplexityModelConfig `yaml:"complexity_model,omitempty"`
	Math            SkillRouterMathConfig            `yaml:"math,omitempty"`

	// DynamicEffort, when true, derives the reasoning/thinking effort per query
	// from the prompt complexity label, clamped by the routing-preference window
	// (eco..max), instead of the fixed per-model ReasoningEffort. Opt-in so
	// existing profiles keep their current fixed-effort behavior. See
	// pkg/proxy/effort.go.
	DynamicEffort bool `yaml:"dynamic_effort,omitempty"`

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

	// KeywordRules are evaluated before vector scoring. They replace the
	// legacy decision tree for Brick2 routing.
	KeywordRules []SkillRouterKeywordRule `yaml:"keyword_rules,omitempty"`
}

type SkillRouterCapabilityModelConfig struct {
	ModelID   string   `yaml:"model_id,omitempty"`
	LocalPath string   `yaml:"local_path,omitempty"`
	Labels    []string `yaml:"labels,omitempty"`
}

type SkillRouterComplexityModelConfig struct {
	UseClientKey    bool   `yaml:"use_client_key,omitempty"`
	ModelID         string `yaml:"model_id,omitempty"`
	BaseURL         string `yaml:"base_url,omitempty"`
	BearerToken     string `yaml:"bearer_token,omitempty"`
	BearerTokenFile string `yaml:"bearer_token_file,omitempty"`
	TimeoutSeconds  int    `yaml:"timeout_seconds,omitempty"`

	// Protocol mirrors ComplexityServiceConfig.Protocol ("brick" default, or
	// "openai" for an OpenAI-compatible /v1/chat/completions endpoint). When
	// set here it takes precedence over the ComplexityService value.
	Protocol string `yaml:"protocol,omitempty"`

	// ModelName is the model id sent in the OpenAI request body when
	// Protocol="openai". Falls back to ModelID when empty.
	ModelName string `yaml:"model_name,omitempty"`

	// DefaultConfidence mirrors ComplexityServiceConfig.DefaultConfidence and,
	// when set here, takes precedence. Used by the OpenAI protocol when the
	// endpoint returns no usable logprobs. Default 0.5.
	DefaultConfidence *float64 `yaml:"default_confidence,omitempty"`
}

type SkillRouterMathConfig struct {
	Tau               map[string]float64 `yaml:"tau,omitempty"`
	OverPenaltyLambda float64            `yaml:"over_penalty_lambda,omitempty"`
	TieEpsilon        float64            `yaml:"tie_epsilon,omitempty"`
	ClipMin           float64            `yaml:"clip_min,omitempty"`
	ClipMax           float64            `yaml:"clip_max,omitempty"`

	// Routing-preference knob math (paper "Locked production math configuration";
	// reference: packages/evals/baselines/sweep_knob_aggressive.py
	// effective_knob_params / evaluate_knob). Difficulty lift becomes
	//   z_q = complexity_bias + complexity_mu * logit(tau_query)
	// and the per-model objective
	//   J_m = D_m + cost_penalty_beta * cost_weight_m.
	// RoutingPreference (r in [-1,1]) reshapes mu/bias/beta/lambda through an
	// asymmetric power law anchored by the max_*/min_* fields. Pointer types are
	// used where zero is a legitimate value distinct from "absent".
	RoutingPreference *float64 `yaml:"routing_preference,omitempty"`
	ComplexityMu      float64  `yaml:"complexity_mu,omitempty"`
	ComplexityBias    *float64 `yaml:"complexity_bias,omitempty"`
	CostPenaltyBeta   float64  `yaml:"cost_penalty_beta,omitempty"`
	PreferencePower   float64  `yaml:"preference_power,omitempty"`
	MaxMuMultiplier   float64  `yaml:"max_mu_multiplier,omitempty"`
	MaxBiasShift      *float64 `yaml:"max_bias_shift,omitempty"`
	MaxCostRelief     float64  `yaml:"max_cost_relief,omitempty"`
	MaxOverRelief     float64  `yaml:"max_over_relief,omitempty"`
	MinMuMultiplier   float64  `yaml:"min_mu_multiplier,omitempty"`
	MinBiasShift      *float64 `yaml:"min_bias_shift,omitempty"`
	MinCostBoost      float64  `yaml:"min_cost_boost,omitempty"`
	MinOverBoost      float64  `yaml:"min_over_boost,omitempty"`
}

type SkillRouterModelConfig struct {
	UseClientKey bool   `yaml:"use_client_key,omitempty"`
	Model        string `yaml:"model"`

	// SkillVector must follow SkillRouterConfig.Capabilities order.
	SkillVector []float64 `yaml:"skill_vector,omitempty"`

	// Optional tie-break metadata.
	CostWeight    float64 `yaml:"cost_weight,omitempty"`
	LatencyWeight float64 `yaml:"latency_weight,omitempty"`

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

type SkillRouterKeywordRule struct {
	Name          string             `yaml:"name"`
	Mode          string             `yaml:"mode,omitempty"` // override or bias
	Importance    int                `yaml:"importance,omitempty"`
	Model         string             `yaml:"model,omitempty"`
	Capability    string             `yaml:"capability,omitempty"`
	Bias          map[string]float64 `yaml:"bias,omitempty"`
	Operator      string             `yaml:"operator,omitempty"` // OR or AND
	Keywords      []string           `yaml:"keywords"`
	CaseSensitive bool               `yaml:"case_sensitive,omitempty"`
}

// ResolveBearerToken returns the effective bearer token. Lookup order:
//  1. BearerToken (literal). Goes through os.ExpandEnv so a value like
//     "${BRICK_CLASSIFIER_TOKEN}" resolves at startup — useful for profile
//     processes that inject the token through their environment.
//  2. BearerTokenFile (path). Trimmed contents.
//
// Returns empty string with no error when neither is set (auth disabled).
func (c *ComplexityServiceConfig) ResolveBearerToken() (string, error) {
	if c.BearerToken != "" {
		return expandCredential(c.BearerToken)
	}
	if c.BearerTokenFile == "" {
		return "", nil
	}
	b, err := os.ReadFile(c.BearerTokenFile)
	if err != nil {
		return "", fmt.Errorf("read bearer_token_file %q: %w", c.BearerTokenFile, err)
	}
	return ValidateCredential(string(b))
}

type ModelReasoningControl struct {
	UseReasoning    *bool  `yaml:"use_reasoning"`              // Pointer to detect missing field
	ReasoningEffort string `yaml:"reasoning_effort,omitempty"` // Model-specific reasoning effort level (low, medium, high)
}
