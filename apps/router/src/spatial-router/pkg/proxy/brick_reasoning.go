package proxy

import (
	"encoding/json"

	"github.com/regolo-ai/brick-SR1/apps/router/src/spatial-router/pkg/config"
)

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
		delete(raw, "thinking")
		delete(raw, "reasoning_effort")
		delete(raw, "chat_template_kwargs")
		out, err := json.Marshal(raw)
		if err != nil {
			return body
		}
		return out
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

	if family != nil && family.Parameter == "reasoning_effort" {
		raw["reasoning_effort"] = effort
	} else {
		raw["thinking"] = true
		if effort != "" {
			raw["reasoning_effort"] = effort
		}
	}

	out, err := json.Marshal(raw)
	if err != nil {
		return body
	}
	return out
}
