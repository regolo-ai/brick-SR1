package proxy

import (
	"encoding/json"

	"github.com/regolo-ai/brick-SR1/apps/router/src/spatial-router/pkg/config"
)

func applyBrickReasoning(body []byte, cfg *config.RouterConfig, modelName string) []byte {
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
	effort := selected.ReasoningEffort
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
