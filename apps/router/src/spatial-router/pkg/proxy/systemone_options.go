package proxy

import (
	"encoding/json"
	"github.com/regolo-ai/brick-SR1/apps/router/src/spatial-router/pkg/brickrouting"
	"strings"
)

// Request effort overrides the profile knob while retaining candidate filters.
func requestRoutingOptions(body []byte, candidates map[string]bool) brickrouting.RoutingOptions {
	options := brickrouting.RoutingOptions{Candidates: candidates}
	effort := requestEffort(body)
	switch strings.ToLower(strings.TrimSpace(effort)) {
	case "low", "medium", "high", "xhigh", "max":
		knob := effortKnob(effort)
		options.Knob = &knob
	}
	return options
}

func requestEffort(body []byte) string {
	var raw struct {
		OutputConfig struct {
			Effort string `json:"effort"`
		} `json:"output_config"`
		Reasoning struct {
			Effort string `json:"effort"`
		} `json:"reasoning"`
		Effort string `json:"reasoning_effort"`
	}
	if json.Unmarshal(body, &raw) != nil {
		return ""
	}
	effort := raw.OutputConfig.Effort
	if effort == "" {
		effort = raw.Reasoning.Effort
	}
	if effort == "" {
		effort = raw.Effort
	}
	return strings.TrimSpace(effort)
}
