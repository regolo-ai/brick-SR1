package config

import (
	"fmt"
	"strings"
)

func validateConfigStructure(cfg *RouterConfig) error {
	if cfg.ConfigVersion != 0 && cfg.ConfigVersion != 1 {
		return fmt.Errorf("unsupported config_version: %d", cfg.ConfigVersion)
	}
	if err := validateSkillRouterConfig(cfg); err != nil {
		return err
	}
	return validateCodexRouterConfig(cfg)
}
func validateCodexRouterConfig(cfg *RouterConfig) error {
	if !cfg.CodexRouter.Enabled {
		return nil
	}
	known := map[string]bool{"function_tools": true, "custom_tools": true, "opaque_reasoning": true, "images": true, "audio": true, "files": true, "compaction": true, "previous_response": true}
	validateCapabilities := func(owner string, capabilities []string) error {
		seen := map[string]bool{}
		for _, capability := range capabilities {
			if capability == "multimodal" {
				return fmt.Errorf("%s uses removed capability multimodal; declare images, audio, and files separately", owner)
			}
			if capability == "" || (!known[capability] && !strings.HasPrefix(capability, "item:")) {
				return fmt.Errorf("%s contains unknown transport capability %q", owner, capability)
			}
			if seen[capability] {
				return fmt.Errorf("%s contains duplicate transport capability %q", owner, capability)
			}
			seen[capability] = true
		}
		return nil
	}
	for name, provider := range cfg.ProviderProfiles {
		if err := validateCapabilities("provider_profiles."+name+".capabilities", provider.Capabilities); err != nil {
			return err
		}
	}
	for model, params := range cfg.ModelConfig {
		if params.TransportCapabilities != nil {
			if err := validateCapabilities("model_config."+model+".transport_capabilities", params.TransportCapabilities); err != nil {
				return err
			}
		}
	}
	active := map[string]bool{}
	if len(cfg.SkillRouter.ActiveModels) > 0 {
		for _, model := range cfg.SkillRouter.ActiveModels {
			active[model] = true
		}
	} else {
		for _, model := range cfg.SkillRouter.Models {
			active[model.Model] = true
		}
	}
	for model := range active {
		if cfg.ModelConfig[model].ContextWindowSize <= 0 {
			return fmt.Errorf("active Codex model %q requires context_window_size", model)
		}
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

	// active_models, when present, must reference models declared in
	// skill_router.models (no duplicates). Empty is allowed and means "all
	// models are candidates" (backward compatible).
	if len(sr.ActiveModels) > 0 {
		activeSeen := map[string]bool{}
		for i, m := range sr.ActiveModels {
			if !modelSeen[m] {
				return fmt.Errorf("skill_router.active_models[%d] %q is not defined in skill_router.models", i, m)
			}
			if activeSeen[m] {
				return fmt.Errorf("skill_router.active_models contains duplicate model %q", m)
			}
			activeSeen[m] = true
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
