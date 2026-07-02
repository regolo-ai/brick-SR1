package proxy

import (
	"encoding/json"
	"slices"

	"github.com/regolo-ai/brick-SR1/apps/router/src/spatial-router/pkg/config"
)

func stripBrickReasoningFields(raw map[string]interface{}) {
	delete(raw, "thinking")
	delete(raw, "reasoning_effort")
	delete(raw, "chat_template_kwargs")
}

func marshalBrickReasoning(body []byte, raw map[string]interface{}) []byte {
	out, err := json.Marshal(raw)
	if err != nil {
		return body
	}
	return out
}

// applyBrickReasoning injects (or strips) reasoning controls on the
// OpenAI-compatible brick forward path. When skill_router.dynamic_effort is set,
// the effort is derived per query from complexityLabel and clamped by the
// routing-preference window; otherwise it uses the fixed per-model
// ReasoningEffort (legacy behavior). A model with use_reasoning=false has all
// reasoning fields stripped (this is the OpenAI-pool "supports reasoning" guard).
func applyBrickReasoning(body []byte, cfg *config.RouterConfig, modelName, complexityLabel string) []byte {
	if cfg == nil {
		return body
	}
	var selected *config.SkillRouterModelConfig
	for i := range cfg.SkillRouter.Models {
		if cfg.SkillRouter.Models[i].Model == modelName {
			selected = &cfg.SkillRouter.Models[i]
			break
		}
	}
	if selected == nil || selected.UseReasoning == nil {
		return body
	}

	var raw map[string]interface{}
	if err := json.Unmarshal(body, &raw); err != nil {
		return body
	}

	if !*selected.UseReasoning {
		stripBrickReasoningFields(raw)
		return marshalBrickReasoning(body, raw)
	}

	family := cfg.GetModelReasoningFamily(modelName)
	var effort string
	if cfg.SkillRouter.DynamicEffort {
		effort = vocabAt(brickEffortVocab, resolveEffortLevel(complexityLabel, routingPreferenceOf(cfg)))
	} else {
		effort = selected.ReasoningEffort
	}
	if effort == "" {
		effort = cfg.DefaultReasoningEffort
	}
	if effort == "" {
		effort = "medium"
	}

	// Enforce per-model allowlist: se allowed_thinking_modes è configurato,
	// clamp l'effort al valore consentito più vicino (scala decrescente).
	// "off" in allowlist = strip completo del reasoning.
	if allowed := cfg.GetAllowedThinkingModes(modelName); len(allowed) > 0 {
		if slices.Contains(allowed, "off") {
			stripBrickReasoningFields(raw)
			return marshalBrickReasoning(body, raw)
		}
		effortOrder := []string{"max", "xhigh", "high", "medium", "low"}
		idx := slices.Index(effortOrder, effort)
		if idx < 0 {
			idx = len(effortOrder) - 1
		}
		found := false
		for i := idx; i < len(effortOrder); i++ {
			if slices.Contains(allowed, effortOrder[i]) {
				effort = effortOrder[i]
				found = true
				break
			}
		}
		if !found {
			// Nessun valore consentito uguale o inferiore: usa il minimo permesso
			for i := len(effortOrder) - 1; i >= 0; i-- {
				if slices.Contains(allowed, effortOrder[i]) {
					effort = effortOrder[i]
					break
				}
			}
		}
	}

	if family != nil && family.Parameter == "reasoning_effort" {
		raw["reasoning_effort"] = effort
	} else {
		raw["thinking"] = true
		if effort != "" {
			raw["reasoning_effort"] = effort
		}
	}

	return marshalBrickReasoning(body, raw)
}

// applyBrickReasoningLevel injects (or strips) OpenAI-compatible reasoning
// controls using an explicit autonomous effort ladder level. It returns the
// serialized body and the effort string that was actually emitted ("off" when
// reasoning was stripped by model capability or allowed_thinking_modes).
func applyBrickReasoningLevel(body []byte, cfg *config.RouterConfig, modelName string, level int) ([]byte, string) {
	if cfg == nil {
		return body, ""
	}
	selected := findSkillRouterModel(cfg, modelName)
	if selected == nil || selected.UseReasoning == nil {
		return body, ""
	}

	var raw map[string]interface{}
	if err := json.Unmarshal(body, &raw); err != nil {
		return body, ""
	}

	if !*selected.UseReasoning {
		stripBrickReasoningFields(raw)
		return marshalBrickReasoning(body, raw), "off"
	}

	level = clampEffortLevelToAllowlist(level, modelName, cfg)
	if level < 0 {
		stripBrickReasoningFields(raw)
		return marshalBrickReasoning(body, raw), "off"
	}

	effort := vocabAt(brickEffortVocab, level)
	if effort == "" {
		effort = cfg.DefaultReasoningEffort
	}
	if effort == "" {
		effort = "medium"
	}

	family := cfg.GetModelReasoningFamily(modelName)
	if family != nil && family.Parameter == "reasoning_effort" {
		raw["reasoning_effort"] = effort
	} else {
		raw["thinking"] = true
		raw["reasoning_effort"] = effort
	}

	return marshalBrickReasoning(body, raw), effort
}
