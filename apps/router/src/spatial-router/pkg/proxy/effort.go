package proxy

import (
	"encoding/json"
	"slices"
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
// effort bump. There is intentionally no symmetric -1 cut: the router already
// picks the best-fitting model, so under-capacity is ~0 for nearly every
// request; a low-headroom decrement would therefore fire on every query and
// pin the effort one rung below the complexity ladder. Headroom baseline = 0.
const stretchHigh = 0.80

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

// modeBiasForPreference maps the routing preference r in [-1,1] (the Brick mode
// knob: eco/lite/mid/pro/max) to an additive effort bias. The mode shifts the
// whole effort distribution up or down WITHOUT collapsing per-query granularity:
// two queries of different difficulty in the same mode still land on different
// rungs; the mode only translates them. Bands mirror effortWindowForPreference.
//
//	eco  (r<=-0.75) -> -2
//	lite (r<=-0.25) -> -1
//	mid  (r< 0.25)  ->  0
//	pro  (r< 0.75)  -> +1
//	max  (else)     -> +2
func modeBiasForPreference(r float64) int {
	switch {
	case r <= -0.75:
		return -2
	case r <= -0.25:
		return -1
	case r < 0.25:
		return 0
	case r < 0.75:
		return 1
	default:
		return 2
	}
}

// autonomousEffortLevel derives the reasoning-effort ordinal from the router's
// own signals plus the Brick mode bias. It starts from absolute query difficulty
// (tauQuery via ladderFromTau), bumps +1 when the chosen model is stretched
// (underCapacity >= stretchHigh) for that query, and adds the mode bias
// (modeBiasForPreference): the mode is an additive shift, not a fixed trajectory,
// so per-query granularity is preserved while eco..max moves the whole band. The
// result is clamped to the 0..5 ladder. There is no headroom decrement: the
// router selects the best-fitting model, so underCapacity is ~0 on nearly every
// request and a -1 cut would fire universally.
func autonomousEffortLevel(tauQuery, underCapacity, preference float64) int {
	level := ladderFromTau(tauQuery)
	if underCapacity >= stretchHigh {
		level++
	}
	level += modeBiasForPreference(preference)
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
// output_config.effort) to a Brick routing preference r in [-1,1], which drives
// MODEL selection via RouteWithPreference. This lets the effort picker in Claude
// Code act as the Brick mode selector.
//
// The positive-side values are tuned for a softened knob (skill_router.math.
// preference_power = 2.2 in the default profile) and a sonnet+opus pool, to give
// a graded opus share across the top modes rather than a near-step jump:
//
//	low    (r=-1.0): cheapest tier only (sonnet), minimal effort
//	medium (r=-0.5): cost-conscious, sonnet
//	high   (r=+0.39): opus on genuinely hard queries (~40%), sonnet otherwise (~60%)
//	xhigh  (r=+0.45): opus majority (~70%), sonnet on easy (~30%)
//	max    (r=+0.47): opus for almost everything (~90%), sonnet only on the easiest
//
// NOTE: these anchors are matched to preference_power=2.2 AND a sonnet-5+opus
// pool, tuned live against the hosted complexity classifier (so tau spans
// easy/medium/hard, not a flat 0.72). They were re-tuned 2026-07-14 after a
// classifier misconfiguration (see brickrouting complexity fallback hardening)
// was masking the true curve: with a healthy classifier the old 0.43/0.452/0.52
// anchors collapsed high==xhigh (both ~47%) and jumped max straight to 0% sonnet.
// The current values give a graded 60/30/10 sonnet share. Raising preference_power
// back toward the paper default (2.92) steepens the curve and re-collapses the
// high/xhigh gap; keep the two in sync when retuning.
func clientEffortToPreference(effort string) float64 {
	switch strings.ToLower(strings.TrimSpace(effort)) {
	case "low":
		return -1.0
	case "medium":
		return -0.5
	case "high":
		return 0.39
	case "xhigh":
		return 0.45
	case "max":
		return 0.47
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

// clampEffortLevelToAllowlist restituisce il livello di effort da usare per
// selectedModel, rispettando l'eventuale allowlist configurata in model_config.
// Se allowed_thinking_modes contiene "off", restituisce -1 come sentinel:
// il sito di chiamata deve saltare l'iniezione dell'effort.
// In tutti gli altri casi il livello viene clampato al valore consentito più
// basso nella scala (5=max, 4=xhigh, 3=high, 2=medium, 1-0=low).
func clampEffortLevelToAllowlist(level int, modelName string, cfg *config.RouterConfig) int {
	allowed := cfg.GetAllowedThinkingModes(modelName)
	if len(allowed) == 0 {
		return level // nessun vincolo
	}
	// "off" in allowlist = blocca tutto il reasoning
	if slices.Contains(allowed, "off") {
		return -1 // sentinel: il chiamante deve saltare l'iniezione
	}
	// Mappa ladder ordinal → vocabolario condiviso per il confronto
	effortVocabOrder := []string{"low", "low", "medium", "high", "xhigh", "max"}
	// Scende dal livello richiesto finché trova un valore permesso
	for i := level; i >= 0; i-- {
		if i < len(effortVocabOrder) && slices.Contains(allowed, effortVocabOrder[i]) {
			return i
		}
	}
	// Nessun valore consentito uguale o inferiore: usa il minimo permesso
	for i := 0; i < len(effortVocabOrder); i++ {
		if slices.Contains(allowed, effortVocabOrder[i]) {
			return i
		}
	}
	return level // fallback conservativo
}
