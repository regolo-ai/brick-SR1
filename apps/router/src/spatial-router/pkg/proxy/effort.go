package proxy

import (
	"encoding/json"
	"strings"
)

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
