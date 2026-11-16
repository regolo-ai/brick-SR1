package proxy

import (
	"encoding/json"
	"fmt"
	"math"
	"slices"
	"strconv"
	"strings"

	"github.com/regolo-ai/brick-SR1/apps/router/src/spatial-router/pkg/config"
)

// KnobHeader carries an explicit routing knob from native Brick clients.
const KnobHeader = "X-Brick-Knob"

// effortLadder is the ordered vocabulary shared by the knob/effort mapping.
var effortLadder = []string{"low", "medium", "high", "xhigh", "max"}

// parseKnob validates an explicit knob header value.
func parseKnob(raw string) (float64, error) {
	knob, err := strconv.ParseFloat(strings.TrimSpace(raw), 64)
	if err != nil || math.IsNaN(knob) || math.IsInf(knob, 0) || knob < -1 || knob > 1 {
		return 0, fmt.Errorf("invalid %s value; expected a number in [-1, 1]", KnobHeader)
	}
	return knob, nil
}

// knobToEffort maps a routing knob in [-1,1] onto the five-bucket effort
// vocabulary used by Codex and Claude Code.
func knobToEffort(knob float64) string {
	switch {
	case knob < -0.6:
		return "low"
	case knob < -0.2:
		return "medium"
	case knob < 0.2:
		return "high"
	case knob < 0.6:
		return "xhigh"
	default:
		return "max"
	}
}

// clampEffortToAllowed returns the closest provider-supported effort for the
// requested level, walking down then up the ladder. An empty allowed list means
// every level is permitted.
func clampEffortToAllowed(effort string, allowed []string) string {
	if len(allowed) == 0 {
		return effort
	}
	if slices.Contains(allowed, effort) {
		return effort
	}
	index := slices.Index(effortLadder, effort)
	if index < 0 {
		return ""
	}
	for candidate := index; candidate >= 0; candidate-- {
		if slices.Contains(allowed, effortLadder[candidate]) {
			return effortLadder[candidate]
		}
	}
	for candidate := index + 1; candidate < len(effortLadder); candidate++ {
		if slices.Contains(allowed, effortLadder[candidate]) {
			return effortLadder[candidate]
		}
	}
	return ""
}

// applyKnobEffort fills an existing, empty reasoning container from the resolved
// knob. It never overwrites a client-provided effort (the client always wins
// when it explicitly asks for one) and never creates a container the client did
// not use.
func applyKnobEffort(body []byte, cfg *config.RouterConfig, model string, knob float64) []byte {
	if cfg == nil {
		return body
	}
	if selected := findSkillRouterModel(cfg, model); selected != nil && selected.UseReasoning != nil && !*selected.UseReasoning {
		return body
	}
	allowed := cfg.GetAllowedThinkingModes(model)
	if slices.Contains(allowed, "off") {
		return body
	}
	effort := clampEffortToAllowed(knobToEffort(knob), allowed)
	if effort == "" {
		return body
	}
	var raw map[string]interface{}
	if json.Unmarshal(body, &raw) != nil {
		return body
	}
	changed := false
	if value, ok := raw["reasoning_effort"]; ok {
		if text, _ := value.(string); strings.TrimSpace(text) == "" {
			raw["reasoning_effort"] = effort
			changed = true
		}
	} else if reasoning, ok := raw["reasoning"].(map[string]interface{}); ok {
		if text, _ := reasoning["effort"].(string); strings.TrimSpace(text) == "" {
			reasoning["effort"] = effort
			changed = true
		}
	} else if output, ok := raw["output_config"].(map[string]interface{}); ok {
		if text, _ := output["effort"].(string); strings.TrimSpace(text) == "" {
			output["effort"] = effort
			changed = true
		}
	}
	if !changed {
		return body
	}
	encoded, err := json.Marshal(raw)
	if err != nil {
		return body
	}
	return encoded
}

func effortKnob(effort string) float64 {
	switch strings.ToLower(strings.TrimSpace(effort)) {
	case "low":
		return -1.0
	case "medium":
		return -0.5
	case "high":
		return 0.0
	case "xhigh":
		return 0.5
	case "max":
		return 1.0
	default:
		return 0.0 // treat unknown as mid
	}
}

func extractClientEffort(body []byte) string {
	var raw struct {
		OutputConfig struct {
			Effort string `json:"effort"`
		} `json:"output_config"`
	}
	if err := json.Unmarshal(body, &raw); err != nil {
		return ""
	}
	return strings.TrimSpace(raw.OutputConfig.Effort)
}

func extractRequestedModel(body []byte) string {
	var raw struct {
		Model string `json:"model"`
	}
	if err := json.Unmarshal(body, &raw); err != nil {
		return ""
	}
	return strings.TrimSpace(raw.Model)
}
