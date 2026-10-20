package config

// Deprecated 3.x routing fields. They are parsed only so a 3.x profile gets a
// precise migration diagnostic instead of a generic unknown-field failure. The
// adapter in migrate.go clears them before validation; nothing here is read
// after migration.

type LegacyComplexityServiceConfig struct {
	UseClientKey      bool     `yaml:"use_client_key,omitempty"`
	Enabled           bool     `yaml:"enabled"`
	TimeoutSeconds    int      `yaml:"timeout_seconds,omitempty"`
	BaseURL           string   `yaml:"base_url,omitempty"`
	BearerToken       string   `yaml:"bearer_token,omitempty"`
	BearerTokenFile   string   `yaml:"bearer_token_file,omitempty"`
	Protocol          string   `yaml:"protocol,omitempty"`
	ModelName         string   `yaml:"model_name,omitempty"`
	DefaultConfidence *float64 `yaml:"default_confidence,omitempty"`
}

type LegacyCapabilityModelConfig struct {
	ModelID   string   `yaml:"model_id,omitempty"`
	LocalPath string   `yaml:"local_path,omitempty"`
	Labels    []string `yaml:"labels,omitempty"`
}

type LegacyComplexityModelConfig struct {
	UseClientKey      bool     `yaml:"use_client_key,omitempty"`
	ModelID           string   `yaml:"model_id,omitempty"`
	BaseURL           string   `yaml:"base_url,omitempty"`
	BearerToken       string   `yaml:"bearer_token,omitempty"`
	BearerTokenFile   string   `yaml:"bearer_token_file,omitempty"`
	TimeoutSeconds    int      `yaml:"timeout_seconds,omitempty"`
	Protocol          string   `yaml:"protocol,omitempty"`
	ModelName         string   `yaml:"model_name,omitempty"`
	DefaultConfidence *float64 `yaml:"default_confidence,omitempty"`
}

type LegacyMathConfig struct {
	Tau               map[string]float64 `yaml:"tau,omitempty"`
	OverPenaltyLambda float64            `yaml:"over_penalty_lambda,omitempty"`
	TieEpsilon        float64            `yaml:"tie_epsilon,omitempty"`
	ClipMin           float64            `yaml:"clip_min,omitempty"`
	ClipMax           float64            `yaml:"clip_max,omitempty"`
	RoutingPreference *float64           `yaml:"routing_preference,omitempty"`
	ComplexityMu      float64            `yaml:"complexity_mu,omitempty"`
	ComplexityBias    *float64           `yaml:"complexity_bias,omitempty"`
	CostPenaltyBeta   float64            `yaml:"cost_penalty_beta,omitempty"`
	PreferencePower   float64            `yaml:"preference_power,omitempty"`
	MaxMuMultiplier   float64            `yaml:"max_mu_multiplier,omitempty"`
	MaxBiasShift      *float64           `yaml:"max_bias_shift,omitempty"`
	MaxCostRelief     float64            `yaml:"max_cost_relief,omitempty"`
	MaxOverRelief     float64            `yaml:"max_over_relief,omitempty"`
	MinMuMultiplier   float64            `yaml:"min_mu_multiplier,omitempty"`
	MinBiasShift      *float64           `yaml:"min_bias_shift,omitempty"`
	MinCostBoost      float64            `yaml:"min_cost_boost,omitempty"`
	MinOverBoost      float64            `yaml:"min_over_boost,omitempty"`
}

type LegacyKeywordRuleConfig struct {
	Name          string             `yaml:"name"`
	Mode          string             `yaml:"mode,omitempty"`
	Importance    int                `yaml:"importance,omitempty"`
	Model         string             `yaml:"model,omitempty"`
	Capability    string             `yaml:"capability,omitempty"`
	Bias          map[string]float64 `yaml:"bias,omitempty"`
	Operator      string             `yaml:"operator,omitempty"`
	Keywords      []string           `yaml:"keywords"`
	CaseSensitive bool               `yaml:"case_sensitive,omitempty"`
}
