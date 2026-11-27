package config

import (
	"fmt"
	"math"
	"strings"
)

func validateConfigStructure(cfg *RouterConfig) error {
	if cfg.ConfigVersion != 0 && cfg.ConfigVersion != 2 {
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
	if math.IsNaN(sr.Knob) || math.IsInf(sr.Knob, 0) || sr.Knob < -1 || sr.Knob > 1 {
		return fmt.Errorf("skill_router.knob must be finite and in [-1, 1]")
	}
	if sr.OverCapacityWeight != nil {
		weight := *sr.OverCapacityWeight
		if math.IsNaN(weight) || math.IsInf(weight, 0) || weight < 0 || weight > 1 {
			return fmt.Errorf("skill_router.over_capacity_weight must be finite and in [0, 1]")
		}
	}
	expected := map[string]bool{"instruction_following": true, "coding": true, "math_reasoning": true, "world_knowledge": true, "planning_agentic": true, "creative_synthesis": true}
	if len(sr.Capabilities) != 6 {
		return fmt.Errorf("skill_router.capabilities must declare the six SystemOne dimensions")
	}
	for _, name := range sr.Capabilities {
		if !expected[name] {
			return fmt.Errorf("invalid or duplicate SystemOne capability %q", name)
		}
		delete(expected, name)
	}
	if len(sr.Models) == 0 {
		return fmt.Errorf("skill_router.models must contain at least one candidate")
	}
	seen := map[string]bool{}
	for i, model := range sr.Models {
		if model.Model == "" || seen[model.Model] {
			return fmt.Errorf("invalid or duplicate skill_router.models[%d].model", i)
		}
		seen[model.Model] = true
		if _, ok := cfg.ModelConfig[model.Model]; !ok {
			return fmt.Errorf("skill_router model %q is not defined in model_config", model.Model)
		}
		if len(model.SkillVector) != 6 {
			return fmt.Errorf("model %s skill_vector must have six dimensions", model.Model)
		}
		for _, value := range model.SkillVector {
			if math.IsNaN(value) || math.IsInf(value, 0) || value < 0 || value > 1 {
				return fmt.Errorf("model %s skill_vector must be finite and in [0, 1]", model.Model)
			}
		}
	}
	active := map[string]bool{}
	for _, name := range sr.ActiveModels {
		if !seen[name] || active[name] {
			return fmt.Errorf("invalid or duplicate active model %q", name)
		}
		active[name] = true
	}
	if err := validateSkillRouterKeywords(sr, seen, active); err != nil {
		return err
	}
	return nil
}

func validateSkillRouterKeywords(sr SkillRouterConfig, models, active map[string]bool) error {
	names := map[string]bool{}
	for i, rule := range sr.Keywords {
		owner := fmt.Sprintf("skill_router.keywords[%d]", i)
		if strings.TrimSpace(rule.Name) == "" {
			return fmt.Errorf("%s.name cannot be empty", owner)
		}
		if names[rule.Name] {
			return fmt.Errorf("duplicate %s.name %q", owner, rule.Name)
		}
		names[rule.Name] = true
		if len(rule.Keywords) == 0 {
			return fmt.Errorf("%s (%q).keywords cannot be empty", owner, rule.Name)
		}
		for _, keyword := range rule.Keywords {
			if strings.TrimSpace(keyword) == "" {
				return fmt.Errorf("%s (%q).keywords cannot contain empty entries", owner, rule.Name)
			}
		}
		switch operator := strings.ToUpper(strings.TrimSpace(rule.Operator)); operator {
		case "", "OR", "AND":
		default:
			return fmt.Errorf("%s (%q).operator must be OR or AND", owner, rule.Name)
		}
		if rule.Model == "" {
			return fmt.Errorf("%s (%q).model is required", owner, rule.Name)
		}
		if !models[rule.Model] {
			return fmt.Errorf("%s (%q).model %q is not listed in skill_router.models", owner, rule.Name, rule.Model)
		}
		if len(sr.ActiveModels) > 0 && !active[rule.Model] {
			return fmt.Errorf("%s (%q).model %q is not an active routing candidate", owner, rule.Name, rule.Model)
		}
	}
	return nil
}
