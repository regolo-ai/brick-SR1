package proxy

import (
	"encoding/json"
	"strings"

	"github.com/regolo-ai/brick-SR1/apps/router/src/spatial-router/pkg/config"
)

// Reasoning effort is resolved per query from the prompt complexity label
// (easy/medium/hard) and clamped to a window derived from the routing
// preference r (the eco/lite/mid/pro/max knob). The result is an internal
// ordinal on a 0..5 ladder, mapped to each provider's own effort vocabulary at
// injection time. L5 ("ultra") is Claude-only (output_config.effort = "max").

// claudeEffortVocab maps the internal ordinal to Anthropic output_config.effort
// (low/medium/high/xhigh/max). Opus 4.8 accepts all five rungs.
var claudeEffortVocab = []string{"low", "low", "medium", "high", "xhigh", "max"}

// claudeEffortVocabNoXhigh is the ladder for Claude models that reject the
// "xhigh" rung (e.g. Sonnet 4.6 supports only low/medium/high/max). L4 collapses
// to "high" so the request stays valid; L5 still reaches "max".
var claudeEffortVocabNoXhigh = []string{"low", "low", "medium", "high", "high", "max"}

// claudeVocabForModel returns the effort vocabulary accepted by the target
// Claude model. Sonnet 4.x rejects "xhigh" (verified upstream: "This model does
// not support effort level 'xhigh'"); Opus accepts the full five-rung ladder.
func claudeVocabForModel(model string) []string {
	if strings.Contains(strings.ToLower(model), "sonnet") {
		return claudeEffortVocabNoXhigh
	}
	return claudeEffortVocab
}

// brickEffortVocab maps the internal ordinal to the low/medium/high vocabulary
// understood by every OpenAI-compatible backend in the brick pool (OpenAI,
// Regolo, etc.). minimal/xhigh/max are intentionally avoided here so the value
// stays universally valid across providers.
var brickEffortVocab = []string{"low", "low", "medium", "high", "high", "high"}

// baseEffortForComplexity maps the complexity label to the base effort ordinal
// before the mode clamp: easy->L1, medium->L2, hard->L3.
func baseEffortForComplexity(label string) int {
	switch strings.ToLower(strings.TrimSpace(label)) {
	case "easy":
		return 1
	case "hard":
		return 3
	default: // medium / skipped / unknown
		return 2
	}
}

// effortWindowForPreference maps the routing preference r in [-1,1] to a
// [min,max] ordinal clamp window mirroring the eco/lite/mid/pro/max modes.
func effortWindowForPreference(r float64) (int, int) {
	switch {
	case r <= -0.75:
		return 0, 1 // eco
	case r <= -0.25:
		return 0, 2 // lite
	case r < 0.25:
		return 1, 3 // mid
	case r < 0.75:
		return 2, 4 // pro
	default:
		return 3, 5 // max
	}
}

// resolveEffortLevel derives the internal effort ordinal from the query
// complexity label, clamped by the mode's routing-preference window.
func resolveEffortLevel(complexityLabel string, routingPreference float64) int {
	base := baseEffortForComplexity(complexityLabel)
	lo, hi := effortWindowForPreference(routingPreference)
	if base < lo {
		base = lo
	}
	if base > hi {
		base = hi
	}
	return base
}

func vocabAt(vocab []string, level int) string {
	if level < 0 {
		level = 0
	}
	if level >= len(vocab) {
		level = len(vocab) - 1
	}
	return vocab[level]
}

// Autonomous effort tuning constants (log-odds space). under-capacity is the
// selected model's sqrt(underSum): how far its skill falls short of the lifted
// query requirement. Above stretchHigh the model is stretched and gets a +1
// effort bump; below stretchLow it has comfortable headroom and gets a -1 cut.
const (
	stretchHigh = 0.80
	stretchLow  = 0.15
)

// ladderFromTau maps the continuous query difficulty tau_query in [0,1] (the
// confidence-weighted complexity signal from the router) to an effort ordinal
// on the 0..5 ladder. Thresholds are aligned with the router's default tau
// anchors (easy=0.55, medium=0.72, hard=0.88) so easy->L1, medium->L2,
// hard->L4 before the headroom adjustment.
func ladderFromTau(tau float64) int {
	switch {
	case tau < 0.50:
		return 0
	case tau < 0.62:
		return 1
	case tau < 0.76:
		return 2
	case tau < 0.86:
		return 3
	case tau < 0.93:
		return 4
	default:
		return 5
	}
}

// autonomousEffortLevel derives the reasoning-effort ordinal purely from the
// router's own signals, independent of the routing mode (eco/lite/mid/pro/max).
// It blends absolute query difficulty (tauQuery) with how stretched the chosen
// model is for that query (underCapacity): a model selected with little spare
// capacity is told to think harder to close the gap, while a model picked with
// ample headroom can spend less. The result is clamped to the 0..5 ladder with
// NO mode window — the mode only governs which model was selected upstream.
func autonomousEffortLevel(tauQuery, underCapacity float64) int {
	level := ladderFromTau(tauQuery)
	switch {
	case underCapacity >= stretchHigh:
		level++
	case underCapacity <= stretchLow:
		level--
	}
	if level < 0 {
		level = 0
	}
	if level > 5 {
		level = 5
	}
	return level
}

// routingPreferenceOf returns the configured routing preference r (mode knob),
// defaulting to 0 (balanced / "mid") when absent.
func routingPreferenceOf(cfg *config.RouterConfig) float64 {
	if cfg == nil || cfg.SkillRouter.Math.RoutingPreference == nil {
		return 0
	}
	return *cfg.SkillRouter.Math.RoutingPreference
}

// clientEffortToPreference maps an Anthropic effort string (from the client's
// output_config.effort) to a Brick routing preference r in [-1,1].
// This lets the effort picker in Claude Code act as the Brick mode selector:
//
//	low    → eco  (r=-1.0): all → haiku, minimal effort
//	medium → lite (r=-0.5): cost-conscious, sonnet only for hard
//	high   → mid  (r=0.0):  balanced default (haiku/sonnet/opus by complexity)
//	xhigh  → pro  (r=+0.5): sonnet baseline, opus for hard
//	max    → max  (r=+1.0): all → opus, maximum quality
func clientEffortToPreference(effort string) float64 {
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

// extractClientEffort reads output_config.effort from an Anthropic /v1/messages
// body. Returns "" when the field is absent or the body is not valid JSON.
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

// extractRequestedModel reads the "model" field from an Anthropic /v1/messages
// body. Returns "" when the field is absent or the body is not valid JSON.
func extractRequestedModel(body []byte) string {
	var raw struct {
		Model string `json:"model"`
	}
	if err := json.Unmarshal(body, &raw); err != nil {
		return ""
	}
	return strings.TrimSpace(raw.Model)
}

// applyEffortAnthropic overwrites output_config.effort on an Anthropic
// /v1/messages body with the complexity+mode derived effort. Haiku stripping is
// handled separately by stripUnsupportedFieldsForModel (Haiku rejects effort).
func applyEffortAnthropic(body []byte, cfg *config.RouterConfig, complexityLabel string) []byte {
	if cfg == nil {
		return body
	}
	effort := vocabAt(claudeEffortVocab, resolveEffortLevel(complexityLabel, routingPreferenceOf(cfg)))

	var raw map[string]interface{}
	if err := json.Unmarshal(body, &raw); err != nil {
		return body
	}
	oc, _ := raw["output_config"].(map[string]interface{})
	if oc == nil {
		oc = map[string]interface{}{}
	}
	oc["effort"] = effort
	raw["output_config"] = oc
	out, err := json.Marshal(raw)
	if err != nil {
		return body
	}
	return out
}

// applyEffortAnthropicLevel overwrites output_config.effort on an Anthropic
// /v1/messages body with the effort string for an explicit ladder ordinal
// (0..5), using the vocabulary the target model accepts (Sonnet lacks "xhigh").
// Used by the autonomous-effort path, where the level is computed by the
// router's own signals (autonomousEffortLevel) rather than mapped from a mode
// window. Haiku stripping is handled by stripUnsupportedFieldsForModel.
func applyEffortAnthropicLevel(body []byte, level int, model string) []byte {
	effort := vocabAt(claudeVocabForModel(model), level)

	var raw map[string]interface{}
	if err := json.Unmarshal(body, &raw); err != nil {
		return body
	}
	oc, _ := raw["output_config"].(map[string]interface{})
	if oc == nil {
		oc = map[string]interface{}{}
	}
	oc["effort"] = effort
	raw["output_config"] = oc
	out, err := json.Marshal(raw)
	if err != nil {
		return body
	}
	return out
}
