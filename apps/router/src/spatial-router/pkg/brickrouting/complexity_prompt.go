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

// complexityLabels is the fixed label set (mirrors server.py LABELS).
var complexityLabels = []string{"easy", "medium", "hard"}

// normalizeComplexityLabel lowercases/trims a model-produced label and maps any
// out-of-set value to "medium", the safe default shared with the brick path.
func normalizeComplexityLabel(s string) string {
	l := strings.ToLower(strings.TrimSpace(s))
	switch l {
	case "easy", "medium", "hard":
		return l
	}
	// Tolerate decorations a generic model may add ("Easy.", "hard\n", etc.).
	for _, lab := range complexityLabels {
		if strings.Contains(l, lab) {
			return lab
		}
	}
	return "medium"
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
