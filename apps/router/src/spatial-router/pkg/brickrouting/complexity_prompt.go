package brickrouting

import (
	"math"
	"strings"
)

// complexitySystemPrompt mirrors SYSTEM_PROMPT in
// deploy/addons/brick-complexity-server/server.py. Kept byte-identical so a
// model served behind an OpenAI-compatible endpoint sees exactly the same
// instructions the brick complexity classifier was built around.
const complexitySystemPrompt = "You are a query complexity classifier for an LLM routing system. " +
	"Classify the following query into exactly one category:\n" +
	"- easy: Simple factual recall, 1-2 reasoning steps, basic knowledge\n" +
	"- medium: Moderate analysis, 3-5 reasoning steps, domain familiarity needed\n" +
	"- hard: Complex multi-step reasoning, expert knowledge, synthesis across domains\n\n" +
	"Respond with only the label: easy, medium, or hard."

// normalizeComplexityLabel lowercases/trims a model-produced label and reports
// whether it is exactly one of the 3 accepted labels ("easy"/"medium"/"hard").
// Deliberately strict: no fuzzy/substring tolerance. A misconfigured classifier
// (wrong model name, wrong endpoint, generic chat model instead of the
// classifier) tends to echo prose that happens to CONTAIN one of these words
// ("this is not hard to do"), which a substring match would silently accept as
// a confident verdict instead of surfacing the misconfiguration. Callers must
// treat ok=false as a fallback-worthy error (log + metric), not a silent medium.
func normalizeComplexityLabel(s string) (label string, ok bool) {
	l := strings.ToLower(strings.TrimSpace(s))
	switch l {
	case "easy", "medium", "hard":
		return l, true
	}
	return "medium", false
}

// stripProviderPrefix removes a leading "provider/" segment from a model
// identifier so a download/registry coordinate ("regolo/brick-complexity-pro")
// can be reused as an OpenAI-style API model name ("brick-complexity-pro").
// Only the first single-segment prefix is stripped; names without a slash, or
// with an empty tail, are returned unchanged so a genuinely slashless name is
// never mangled. This is a defensive fallback: an explicit model_name always
// wins over it (see newComplexityClient).
func stripProviderPrefix(id string) string {
	i := strings.IndexByte(id, '/')
	if i <= 0 || i == len(id)-1 {
		return id
	}
	// Only strip a single leading provider segment; keep any deeper path intact
	// (e.g. "org/team/model" -> "team/model") since that is unusual but not ours
	// to flatten. The hosted classifier names we emit are single-segment.
	return id[i+1:]
}

// confidenceFromLogprobs computes a calibrated confidence for chosenLabel from
// the top-logprob alternatives of the first generated token. It softmaxes over
// whichever of easy/medium/hard appear in the alternatives. Returns (conf, true)
// when chosenLabel was found among them, else (0, false) so the caller can fall
// back. tokenLogprobs maps an alternative token string to its logprob.
func confidenceFromLogprobs(chosenLabel string, tokenLogprobs map[string]float64) (float64, bool) {
	// Collapse alternatives onto the 3 labels, keeping the max logprob seen
	// for each label (a label may surface as " easy", "easy", "Easy", ...).
	byLabel := make(map[string]float64, 3)
	for tok, lp := range tokenLogprobs {
		lab := strings.ToLower(strings.TrimSpace(tok))
		if lab != "easy" && lab != "medium" && lab != "hard" {
			continue
		}
		if cur, ok := byLabel[lab]; !ok || lp > cur {
			byLabel[lab] = lp
		}
	}
	chosen, ok := byLabel[chosenLabel]
	if !ok {
		return 0, false
	}
	var sum float64
	for _, lp := range byLabel {
		sum += math.Exp(lp)
	}
	if sum <= 0 {
		return 0, false
	}
	return math.Exp(chosen) / sum, true
}
