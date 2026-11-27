package proxy

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"

	"github.com/regolo-ai/brick-SR1/apps/router/src/spatial-router/pkg/brickrouting"
)

// routeReasonHeader reports which routing path produced the decision.
func routeReasonHeader(route *brickrouting.Result) string {
	if route != nil && route.Reason == brickrouting.ReasonKeyword {
		return "keyword"
	}
	return "systemone"
}

// keywordText distinguishes "no user text" from "not provided" for strict
// keyword matching: a pointer to an empty string explicitly disables matching.
func keywordText(value string) *string { return &value }

// writeRoutingError maps routing failures to HTTP. A strict keyword rule whose
// model cannot serve the request is a client error, not an upstream failure.
func writeRoutingError(w http.ResponseWriter, err error, prefix string) {
	var ineligible *brickrouting.KeywordRuleIneligibleError
	if errors.As(err, &ineligible) {
		writeError(w, http.StatusBadRequest, ineligible.Error())
		return
	}
	writeError(w, http.StatusBadGateway, fmt.Sprintf("%s: %v", prefix, err))
}

// requestRoutingOptions resolves the per-request SystemOne knob while retaining
// candidate filters. Precedence: explicit X-Brick-Knob header (native Brick
// clients) > request effort (Codex/Claude Code) > configured profile knob
// (left nil so the router applies skill_router.knob).
func requestRoutingOptions(r *http.Request, body []byte, candidates map[string]bool) (brickrouting.RoutingOptions, error) {
	options := brickrouting.RoutingOptions{Candidates: candidates}
	if r != nil {
		if raw := strings.TrimSpace(r.Header.Get(KnobHeader)); raw != "" {
			knob, err := parseKnob(raw)
			if err != nil {
				return options, err
			}
			options.Knob = &knob
			return options, nil
		}
	}
	switch effort := strings.ToLower(strings.TrimSpace(requestEffort(body))); effort {
	case "low", "medium", "high", "xhigh", "max":
		knob := effortKnob(effort)
		options.Knob = &knob
	}
	return options, nil
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
