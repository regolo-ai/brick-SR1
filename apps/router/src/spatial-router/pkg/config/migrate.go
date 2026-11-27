package config

import (
	"fmt"
	"strings"
)

// ParseOptions controls how deprecated 3.x fields are handled.
type ParseOptions struct {
	// Strict turns every deprecation warning into an error. Use it for managed
	// deployments that must run a fully migrated profile.
	Strict bool
}

// DeprecationError reports that a strict parse found deprecated fields.
type DeprecationError struct {
	Warnings []string
}

func (e *DeprecationError) Error() string {
	return "deprecated configuration: " + strings.Join(e.Warnings, "; ")
}

// migrateDeprecated rewrites a 3.x profile in place and reports every field the
// adapter changed or dropped. It fails when a legacy rule cannot be expressed as
// a strict override, because changing a soft bias into a hard override would
// silently alter routing.
func migrateDeprecated(cfg *RouterConfig) ([]string, error) {
	var warnings []string
	warn := func(format string, args ...any) {
		warnings = append(warnings, fmt.Sprintf(format, args...))
	}

	if cfg.ComplexityService != nil {
		warn("complexity_service is removed; routing uses the local SystemOne classifier")
		cfg.ComplexityService = nil
	}
	if cfg.DefaultReasoningEffort != "" {
		warn("default_reasoning_effort is removed; effort comes from the client request or skill_router.knob")
		cfg.DefaultReasoningEffort = ""
	}

	skill := &cfg.SkillRouter
	if skill.DynamicEffort {
		warn("skill_router.dynamic_effort is removed; effort follows the request knob")
		skill.DynamicEffort = false
	}
	if skill.CapabilityModel != nil {
		warn("skill_router.capability_model is removed; the local SystemOne classifier supplies every capability")
		skill.CapabilityModel = nil
	}
	if skill.ComplexityModel != nil {
		warn("skill_router.complexity_model is removed; the local SystemOne classifier supplies every capability")
		skill.ComplexityModel = nil
	}
	if skill.Math != nil {
		if skill.Math.RoutingPreference != nil {
			if skill.Knob == 0 {
				skill.Knob = *skill.Math.RoutingPreference
				warn("skill_router.math.routing_preference mapped to skill_router.knob=%.2f", skill.Knob)
			} else {
				warn("skill_router.math.routing_preference ignored because skill_router.knob is set")
			}
		}
		warn("skill_router.math is removed; only skill_router.knob remains")
		skill.Math = nil
	}

	if len(skill.KeywordRules) > 0 {
		if len(skill.Keywords) > 0 {
			return nil, fmt.Errorf("skill_router.keywords and the deprecated skill_router.keyword_rules cannot be used together")
		}
		converted := make([]SkillRouterKeywordRuleConfig, 0, len(skill.KeywordRules))
		for i, rule := range skill.KeywordRules {
			mode := strings.ToLower(strings.TrimSpace(rule.Mode))
			if mode == "" {
				mode = "bias"
			}
			if mode != "override" {
				return nil, fmt.Errorf("skill_router.keyword_rules[%d] (%q) uses removed mode %q: only strict overrides are supported; move it to skill_router.keywords without mode, or remove it", i, rule.Name, mode)
			}
			if rule.Capability != "" || len(rule.Bias) > 0 {
				return nil, fmt.Errorf("skill_router.keyword_rules[%d] (%q) uses capability/bias scores, which strict overrides do not support", i, rule.Name)
			}
			converted = append(converted, SkillRouterKeywordRuleConfig{
				Name:          rule.Name,
				Keywords:      rule.Keywords,
				Model:         rule.Model,
				Operator:      rule.Operator,
				CaseSensitive: rule.CaseSensitive,
			})
			if rule.Importance != 0 {
				warn("skill_router.keyword_rules[%d] (%q).importance is ignored; rules evaluate in file order", i, rule.Name)
			}
		}
		skill.Keywords = converted
		skill.KeywordRules = nil
		warn("skill_router.keyword_rules was renamed to skill_router.keywords")
	}

	cfg.ConfigVersion = 2

	for i := range skill.Models {
		model := &skill.Models[i]
		if model.CostWeight != 0 {
			warn("skill_router.models[%d] (%q).cost_weight is removed; distance scoring ignores cost", i, model.Model)
			model.CostWeight = 0
		}
		if model.ReasoningEffort != "" {
			warn("skill_router.models[%d] (%q).reasoning_effort is removed; effort comes from the request", i, model.Model)
			model.ReasoningEffort = ""
		}
	}

	return warnings, nil
}
