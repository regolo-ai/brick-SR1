package config

import (
	"fmt"
	"net"
	"regexp"
	"strings"

	"github.com/regolo-ai/brick-SR1/apps/router/src/spatial-router/pkg/observability/logging"
)

var (
	// Pre-compiled regular expressions for better performance
	protocolRegex = regexp.MustCompile(`^https?://`)
	pathRegex     = regexp.MustCompile(`/`)
	// Pattern to match IPv4 address followed by port number
	ipv4PortRegex = regexp.MustCompile(`^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}:\d+$`)
	// Pattern to match IPv6 address followed by port number [::1]:8080
	ipv6PortRegex = regexp.MustCompile(`^\[.*\]:\d+$`)
)

// validateIPAddress validates IP address format
// Supports IPv4 and IPv6 addresses, rejects domain names, protocol prefixes, paths, etc.
func validateIPAddress(address string) error {
	// Check for empty string
	trimmed := strings.TrimSpace(address)
	if trimmed == "" {
		return fmt.Errorf("address cannot be empty")
	}

	// Check for protocol prefixes (http://, https://)
	if protocolRegex.MatchString(trimmed) {
		return fmt.Errorf("protocol prefixes (http://, https://) are not supported, got: %s", address)
	}

	// Check for paths (contains / character)
	if pathRegex.MatchString(trimmed) {
		return fmt.Errorf("paths are not supported, got: %s", address)
	}

	// Check for port numbers (IPv4 address followed by port or IPv6 address followed by port)
	if ipv4PortRegex.MatchString(trimmed) || ipv6PortRegex.MatchString(trimmed) {
		return fmt.Errorf("port numbers in address are not supported, use 'port' field instead, got: %s", address)
	}

	// Use Go standard library to validate IP address format
	ip := net.ParseIP(trimmed)
	if ip == nil {
		return fmt.Errorf("invalid IP address format, got: %s", address)
	}

	return nil
}

// isValidIPv4 checks if the address is a valid IPv4 address
func isValidIPv4(address string) bool {
	ip := net.ParseIP(address)
	return ip != nil && ip.To4() != nil
}

// isValidIPv6 checks if the address is a valid IPv6 address
func isValidIPv6(address string) bool {
	ip := net.ParseIP(address)
	return ip != nil && ip.To4() == nil
}

// getIPAddressType returns the IP address type information for error messages and debugging
func getIPAddressType(address string) string {
	if isValidIPv4(address) {
		return "IPv4"
	}
	if isValidIPv6(address) {
		return "IPv6"
	}
	return "invalid"
}

// validateConfigStructure performs additional validation on the parsed config
func validateConfigStructure(cfg *RouterConfig) error {
	// In Kubernetes mode, decisions and model_config will be loaded from CRDs
	// Skip validation for these fields during initial config parse
	if cfg.ConfigSource == ConfigSourceKubernetes {
		// Skip validation for decisions and model_config
		return nil
	}

	hasLegacyLatencyConfig := hasLegacyLatencyRoutingConfig(cfg)
	if hasLegacyLatencyConfig {
		return fmt.Errorf("legacy latency config is no longer supported; use decision.algorithm.type=latency_aware and remove signals.latency_rules / conditions.type=latency")
	}

	// File mode: validate decisions have at least one model ref
	for _, decision := range cfg.Decisions {
		if len(decision.ModelRefs) == 0 {
			return fmt.Errorf("decision '%s' has no modelRefs defined - each decision must have at least one model", decision.Name)
		}

		// Validate each model ref has the required fields
		for i, modelRef := range decision.ModelRefs {
			if modelRef.Model == "" {
				return fmt.Errorf("decision '%s', modelRefs[%d]: model name cannot be empty", decision.Name, i)
			}
			if modelRef.UseReasoning == nil {
				return fmt.Errorf("decision '%s', model '%s': missing required field 'use_reasoning'", decision.Name, modelRef.Model)
			}

			// Validate LoRA name if specified
			if modelRef.LoRAName != "" {
				if err := validateLoRAName(cfg, modelRef.Model, modelRef.LoRAName); err != nil {
					return fmt.Errorf("decision '%s', model '%s': %w", decision.Name, modelRef.Model, err)
				}
			}
		}

		// Validate algorithm one-of semantics and type-specific configuration.
		if err := validateDecisionAlgorithmConfig(decision.Name, decision.Algorithm); err != nil {
			return err
		}
	}

	// Validate plugin configurations within each decision
	for _, decision := range cfg.Decisions {
		if imageGenCfg := decision.GetImageGenConfig(); imageGenCfg != nil {
			if err := imageGenCfg.Validate(); err != nil {
				return fmt.Errorf("decision '%s': %w", decision.Name, err)
			}
		}
	}

	// Validate modality detector configuration
	if cfg.ModalityDetector.Enabled {
		if err := cfg.ModalityDetector.ModalityDetectionConfig.Validate(); err != nil {
			return fmt.Errorf("modality_detector: %w", err)
		}
	}

	// Validate image_gen_backends entries
	if err := validateImageGenBackends(cfg); err != nil {
		return err
	}

	// Validate modality decision constraints
	if err := validateModalityDecisions(cfg); err != nil {
		return err
	}

	// Validate modality rules (signal names must be valid)
	if err := validateModalityRules(cfg.Signals.ModalityRules); err != nil {
		return err
	}

	// Validate advanced tool filtering configuration (opt-in)
	if err := validateAdvancedToolFilteringConfig(cfg); err != nil {
		return err
	}

	if err := validateSkillRouterConfig(cfg); err != nil {
		return err
	}

	return nil
}

func validateSkillRouterConfig(cfg *RouterConfig) error {
	sr := cfg.SkillRouter
	if !sr.Enabled {
		return nil
	}

	if len(sr.Capabilities) == 0 {
		return fmt.Errorf("skill_router.enabled=true requires skill_router.capabilities")
	}

	seenCaps := map[string]bool{}
	for _, capName := range sr.Capabilities {
		if strings.TrimSpace(capName) == "" {
			return fmt.Errorf("skill_router.capabilities cannot contain empty names")
		}
		if seenCaps[capName] {
			return fmt.Errorf("skill_router.capabilities contains duplicate %q", capName)
		}
		seenCaps[capName] = true
	}

	if sr.CapabilityModel.ModelID == "" && sr.CapabilityModel.LocalPath == "" {
		return fmt.Errorf("skill_router.capability_model requires model_id or local_path")
	}

	if len(sr.CapabilityModel.Labels) > 0 && len(sr.CapabilityModel.Labels) != len(sr.Capabilities) {
		return fmt.Errorf("skill_router.capability_model.labels length must match skill_router.capabilities")
	}

	if len(sr.Models) == 0 {
		return fmt.Errorf("skill_router.enabled=true requires at least one skill_router.models entry")
	}

	modelSeen := map[string]bool{}
	for i, model := range sr.Models {
		if model.Model == "" {
			return fmt.Errorf("skill_router.models[%d].model cannot be empty", i)
		}
		if modelSeen[model.Model] {
			return fmt.Errorf("skill_router.models contains duplicate model %q", model.Model)
		}
		modelSeen[model.Model] = true
		if _, ok := cfg.ModelConfig[model.Model]; !ok {
			return fmt.Errorf("skill_router.models[%d].model %q is not defined in model_config", i, model.Model)
		}
		if len(model.SkillVector) != len(sr.Capabilities) {
			return fmt.Errorf("skill_router.models[%d].skill_vector length must match skill_router.capabilities", i)
		}
		for j, value := range model.SkillVector {
			if value <= 0 || value >= 1 {
				return fmt.Errorf("skill_router.models[%d].skill_vector[%d] must be in (0,1)", i, j)
			}
		}
	}

	// Preference-knob math constraints (paper sec. brick-knob). Zero values mean
	// "absent" and resolve to the locked production defaults at runtime.
	m := sr.Math
	if m.RoutingPreference != nil && (*m.RoutingPreference < -1 || *m.RoutingPreference > 1) {
		return fmt.Errorf("skill_router.math.routing_preference must be in [-1, 1]")
	}
	if m.PreferencePower < 0 {
		return fmt.Errorf("skill_router.math.preference_power must be > 0 (0 means use the default)")
	}
	for name, v := range map[string]float64{
		"complexity_mu":       m.ComplexityMu,
		"cost_penalty_beta":   m.CostPenaltyBeta,
		"over_penalty_lambda": m.OverPenaltyLambda,
		"max_mu_multiplier":   m.MaxMuMultiplier,
		"max_cost_relief":     m.MaxCostRelief,
		"max_over_relief":     m.MaxOverRelief,
		"min_mu_multiplier":   m.MinMuMultiplier,
		"min_cost_boost":      m.MinCostBoost,
		"min_over_boost":      m.MinOverBoost,
	} {
		if v < 0 {
			return fmt.Errorf("skill_router.math.%s must be >= 0 (0 means use the default)", name)
		}
	}

	for i, rule := range sr.KeywordRules {
		mode := strings.ToLower(strings.TrimSpace(rule.Mode))
		if mode == "" {
			mode = "bias"
		}
		if mode != "override" && mode != "bias" {
			return fmt.Errorf("skill_router.keyword_rules[%d].mode must be override or bias", i)
		}
		if rule.Name == "" {
			return fmt.Errorf("skill_router.keyword_rules[%d].name cannot be empty", i)
		}
		if len(rule.Keywords) == 0 {
			return fmt.Errorf("skill_router.keyword_rules[%d].keywords cannot be empty", i)
		}
		if rule.Importance < 0 || rule.Importance > 10 {
			return fmt.Errorf("skill_router.keyword_rules[%d].importance must be between 0 and 10; 0 uses the default importance", i)
		}
		if mode == "override" {
			if rule.Model == "" {
				return fmt.Errorf("skill_router.keyword_rules[%d] mode=override requires model", i)
			}
			if !modelSeen[rule.Model] {
				return fmt.Errorf("skill_router.keyword_rules[%d].model %q is not listed in skill_router.models", i, rule.Model)
			}
		}
		if mode == "bias" {
			if rule.Capability == "" && len(rule.Bias) == 0 {
				return fmt.Errorf("skill_router.keyword_rules[%d] mode=bias requires capability or bias", i)
			}
			if rule.Capability != "" && !seenCaps[rule.Capability] {
				return fmt.Errorf("skill_router.keyword_rules[%d].capability %q is not in skill_router.capabilities", i, rule.Capability)
			}
			for capName := range rule.Bias {
				if !seenCaps[capName] {
					return fmt.Errorf("skill_router.keyword_rules[%d].bias capability %q is not in skill_router.capabilities", i, capName)
				}
			}
		}
	}

	return nil
}

// validateModalityRules validates modality rule configurations
func validateModalityRules(rules []ModalityRule) error {
	validNames := map[string]bool{"AR": true, "DIFFUSION": true, "BOTH": true}
	for i, rule := range rules {
		if rule.Name == "" {
			return fmt.Errorf("modality_rules[%d]: name cannot be empty", i)
		}
		if !validNames[rule.Name] {
			return fmt.Errorf("modality_rules[%d] (%s): name must be one of \"AR\", \"DIFFUSION\", or \"BOTH\"", i, rule.Name)
		}
	}
	return nil
}

// validateModalityDecisions validates that decisions using modality signals have correct modelRefs.
// Specifically, a BOTH decision must reference both an AR and a diffusion model, OR a single omni model.
func validateModalityDecisions(cfg *RouterConfig) error {
	for _, decision := range cfg.Decisions {
		for _, cond := range decision.Rules.Conditions {
			if cond.Type != SignalTypeModality || cond.Name != "BOTH" {
				continue
			}

			// This decision matches modality=BOTH — must have both AR and diffusion modelRefs,
			// OR at least one omni model that can handle both.
			hasAR := false
			hasDiffusion := false
			hasOmni := false
			for _, ref := range decision.ModelRefs {
				if params, ok := cfg.ModelConfig[ref.Model]; ok {
					switch params.Modality {
					case "ar":
						hasAR = true
					case "diffusion":
						hasDiffusion = true
					case "omni":
						hasOmni = true
					}
				}
			}

			// An omni model satisfies both AR and diffusion requirements
			if hasOmni {
				continue
			}

			if !hasAR || !hasDiffusion {
				return fmt.Errorf("decision %q uses modality condition \"BOTH\" but modelRefs must include both an AR model (modality: \"ar\") and a diffusion model (modality: \"diffusion\"), or an omni model (modality: \"omni\")", decision.Name)
			}
		}
	}
	return nil
}

// validateImageGenBackends validates image_gen_backends entries and model_config references
func validateImageGenBackends(cfg *RouterConfig) error {
	validTypes := map[string]bool{"openai_compatible_omni": true, "openai": true}

	for name, entry := range cfg.ImageGenBackends {
		if entry.Type == "" {
			return fmt.Errorf("image_gen_backends[%s]: type is required (one of \"openai_compatible_omni\", \"openai\")", name)
		}
		if !validTypes[entry.Type] {
			return fmt.Errorf("image_gen_backends[%s]: unknown type %q (must be \"openai_compatible_omni\" or \"openai\")", name, entry.Type)
		}

		switch entry.Type {
		case "openai_compatible_omni":
			if entry.BaseURL == "" {
				return fmt.Errorf("image_gen_backends[%s]: base_url is required for openai_compatible_omni", name)
			}
		case "openai":
			if entry.APIKey == "" {
				return fmt.Errorf("image_gen_backends[%s]: api_key is required for openai", name)
			}
		}
	}

	// Validate model_config image_gen_backend references
	for modelName, params := range cfg.ModelConfig {
		if params.ImageGenBackend != "" {
			if _, ok := cfg.ImageGenBackends[params.ImageGenBackend]; !ok {
				return fmt.Errorf("model_config[%s]: image_gen_backend %q not found in image_gen_backends", modelName, params.ImageGenBackend)
			}
		}
	}

	return nil
}

func hasLegacyLatencyRoutingConfig(cfg *RouterConfig) bool {
	for _, decision := range cfg.Decisions {
		for _, condition := range decision.Rules.Conditions {
			if condition.Type == "latency" {
				return true
			}
		}
	}

	return false
}

func validateDecisionAlgorithmConfig(decisionName string, algorithm *AlgorithmConfig) error {
	if algorithm == nil {
		return nil
	}

	normalizedType := strings.ToLower(strings.TrimSpace(algorithm.Type))
	displayType := strings.TrimSpace(algorithm.Type)
	if displayType == "" {
		displayType = "<empty>"
	}

	configuredBlocks := make([]string, 0, 10)
	addBlock := func(name string, configured bool) {
		if configured {
			configuredBlocks = append(configuredBlocks, name)
		}
	}

	addBlock("confidence", algorithm.Confidence != nil)
	addBlock("ratings", algorithm.Ratings != nil)
	addBlock("remom", algorithm.ReMoM != nil)
	addBlock("elo", algorithm.Elo != nil)
	addBlock("router_dc", algorithm.RouterDC != nil)
	addBlock("automix", algorithm.AutoMix != nil)
	addBlock("hybrid", algorithm.Hybrid != nil)
	addBlock("rl_driven", algorithm.RLDriven != nil)
	addBlock("gmtrouter", algorithm.GMTRouter != nil)
	addBlock("latency_aware", algorithm.LatencyAware != nil)

	if len(configuredBlocks) > 1 {
		return fmt.Errorf(
			"decision '%s': algorithm.type=%s cannot be combined with multiple algorithm config blocks: %s",
			decisionName,
			displayType,
			strings.Join(configuredBlocks, ", "),
		)
	}

	expectedBlockByType := map[string]string{
		"confidence":    "confidence",
		"ratings":       "ratings",
		"remom":         "remom",
		"elo":           "elo",
		"router_dc":     "router_dc",
		"automix":       "automix",
		"hybrid":        "hybrid",
		"rl_driven":     "rl_driven",
		"gmtrouter":     "gmtrouter",
		"latency_aware": "latency_aware",
	}

	expectedBlock, hasExpectedBlock := expectedBlockByType[normalizedType]
	if !hasExpectedBlock {
		if len(configuredBlocks) > 0 {
			return fmt.Errorf(
				"decision '%s': algorithm.type=%s cannot be used with algorithm.%s configuration",
				decisionName,
				displayType,
				configuredBlocks[0],
			)
		}
		return nil
	}

	if len(configuredBlocks) == 1 && configuredBlocks[0] != expectedBlock {
		return fmt.Errorf(
			"decision '%s': algorithm.type=%s requires algorithm.%s configuration; found algorithm.%s",
			decisionName,
			displayType,
			expectedBlock,
			configuredBlocks[0],
		)
	}

	if normalizedType == "latency_aware" {
		if algorithm.LatencyAware == nil {
			return fmt.Errorf("decision '%s': algorithm.type=latency_aware requires algorithm.latency_aware configuration", decisionName)
		}
		if err := validateLatencyAwareAlgorithmConfig(algorithm.LatencyAware); err != nil {
			return fmt.Errorf("decision '%s', algorithm.latency_aware: %w", decisionName, err)
		}
	}

	return nil
}

// validateLatencyAwareAlgorithmConfig validates latency_aware algorithm configuration.
func validateLatencyAwareAlgorithmConfig(cfg *LatencyAwareAlgorithmConfig) error {
	hasTPOTPercentile := cfg.TPOTPercentile > 0
	hasTTFTPercentile := cfg.TTFTPercentile > 0

	if !hasTPOTPercentile && !hasTTFTPercentile {
		return fmt.Errorf("must specify at least one of tpot_percentile (1-100) or ttft_percentile (1-100). RECOMMENDED: use both for comprehensive latency evaluation")
	}

	// Warn (but don't error) if only one is set - recommend using both
	if hasTPOTPercentile && !hasTTFTPercentile {
		logging.Warnf("algorithm.latency_aware: only tpot_percentile is set. RECOMMENDED: also set ttft_percentile for comprehensive latency evaluation (user-perceived latency)")
	}
	if !hasTPOTPercentile && hasTTFTPercentile {
		logging.Warnf("algorithm.latency_aware: only ttft_percentile is set. RECOMMENDED: also set tpot_percentile for comprehensive latency evaluation (token generation throughput)")
	}

	if hasTPOTPercentile && (cfg.TPOTPercentile < 1 || cfg.TPOTPercentile > 100) {
		return fmt.Errorf("tpot_percentile must be between 1 and 100, got: %d", cfg.TPOTPercentile)
	}

	if hasTTFTPercentile && (cfg.TTFTPercentile < 1 || cfg.TTFTPercentile > 100) {
		return fmt.Errorf("ttft_percentile must be between 1 and 100, got: %d", cfg.TTFTPercentile)
	}

	return nil
}

func validateAdvancedToolFilteringConfig(cfg *RouterConfig) error {
	if cfg == nil || cfg.Tools.AdvancedFiltering == nil {
		return nil
	}

	advanced := cfg.Tools.AdvancedFiltering
	if !advanced.Enabled {
		return nil
	}

	if advanced.CandidatePoolSize != nil && *advanced.CandidatePoolSize < 0 {
		return fmt.Errorf("tools.advanced_filtering.candidate_pool_size must be >= 0")
	}

	if advanced.MinLexicalOverlap != nil && *advanced.MinLexicalOverlap < 0 {
		return fmt.Errorf("tools.advanced_filtering.min_lexical_overlap must be >= 0")
	}

	if advanced.MinCombinedScore != nil &&
		(*advanced.MinCombinedScore < 0.0 || *advanced.MinCombinedScore > 1.0) {
		return fmt.Errorf("tools.advanced_filtering.min_combined_score must be between 0.0 and 1.0")
	}

	if advanced.CategoryConfidenceThreshold != nil &&
		(*advanced.CategoryConfidenceThreshold < 0.0 || *advanced.CategoryConfidenceThreshold > 1.0) {
		return fmt.Errorf("tools.advanced_filtering.category_confidence_threshold must be between 0.0 and 1.0")
	}

	weightFields := []struct {
		name  string
		value *float32
	}{
		{"embed", advanced.Weights.Embed},
		{"lexical", advanced.Weights.Lexical},
		{"tag", advanced.Weights.Tag},
		{"name", advanced.Weights.Name},
		{"category", advanced.Weights.Category},
	}
	for _, field := range weightFields {
		if field.value != nil && (*field.value < 0.0 || *field.value > 1.0) {
			return fmt.Errorf("tools.advanced_filtering.weights.%s must be between 0.0 and 1.0", field.name)
		}
	}

	return nil
}

// validateLoRAName checks if the specified LoRA name is defined in the model's configuration
func validateLoRAName(cfg *RouterConfig, modelName string, loraName string) error {
	// Check if the model exists in model_config
	modelParams, exists := cfg.ModelConfig[modelName]
	if !exists {
		return fmt.Errorf("lora_name '%s' specified but model '%s' is not defined in model_config", loraName, modelName)
	}

	// Check if the model has any LoRAs defined
	if len(modelParams.LoRAs) == 0 {
		return fmt.Errorf("lora_name '%s' specified but model '%s' has no loras defined in model_config", loraName, modelName)
	}

	// Check if the specified LoRA name exists in the model's LoRA list
	for _, lora := range modelParams.LoRAs {
		if lora.Name == loraName {
			return nil // Valid LoRA name found
		}
	}

	// LoRA name not found, provide helpful error message
	availableLoRAs := make([]string, len(modelParams.LoRAs))
	for i, lora := range modelParams.LoRAs {
		availableLoRAs[i] = lora.Name
	}
	return fmt.Errorf("lora_name '%s' is not defined in model '%s' loras. Available LoRAs: %v", loraName, modelName, availableLoRAs)
}
