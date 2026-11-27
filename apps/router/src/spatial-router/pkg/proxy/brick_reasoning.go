package proxy

import (
	"encoding/json"
	"github.com/regolo-ai/brick-SR1/apps/router/src/spatial-router/pkg/config"
	"slices"
)

// adaptClientReasoning changes only controls unsupported by the selected provider.
// Missing request effort is left missing; routing never invents reasoning settings.
func adaptClientReasoning(body []byte, cfg *config.RouterConfig, model string) []byte {
	var raw map[string]interface{}
	if json.Unmarshal(body, &raw) != nil {
		return body
	}
	selected := findSkillRouterModel(cfg, model)
	if selected != nil && selected.UseReasoning != nil && !*selected.UseReasoning || slices.Contains(cfg.GetAllowedThinkingModes(model), "off") {
		delete(raw, "thinking")
		delete(raw, "reasoning_effort")
		delete(raw, "reasoning")
		delete(raw, "chat_template_kwargs")
	} else {
		effort := requestEffort(body)
		if effort == "" {
			return body
		}
		allowed := cfg.GetAllowedThinkingModes(model)
		if len(allowed) > 0 && !slices.Contains(allowed, effort) {
			order := []string{"low", "medium", "high", "xhigh", "max"}
			index := slices.Index(order, effort)
			if index < 0 {
				return body
			}
			for index >= 0 && !slices.Contains(allowed, order[index]) {
				index--
			}
			if index < 0 {
				for index = 0; index < len(order) && !slices.Contains(allowed, order[index]); index++ {
				}
			}
			if index < len(order) {
				effort = order[index]
			}
		}
		if _, ok := raw["reasoning_effort"]; ok {
			raw["reasoning_effort"] = effort
		}
		if reasoning, ok := raw["reasoning"].(map[string]interface{}); ok {
			reasoning["effort"] = effort
		}
	}
	encoded, err := json.Marshal(raw)
	if err != nil {
		return body
	}
	return encoded
}
