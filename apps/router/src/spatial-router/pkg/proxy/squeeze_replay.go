package proxy

import (
	"encoding/json"

	"github.com/regolo-ai/brick-SR1/apps/router/src/spatial-router/pkg/compaction"
	"github.com/regolo-ai/brick-SR1/apps/router/src/spatial-router/pkg/economics"
)

// This file is the offline smartsqueeze measurement harness: given a real
// conversation body (the {model, system, messages} an agent would send at a
// model-switch turn), it runs the production compactor (pkg/compaction.Compact)
// and prices the re-prefill it avoids, using the SAME turnCost / cache-price
// multipliers the live economics endpoint uses (replay.go, economics.go).
//
// Why this is separate from replayCounterfactual: that one measures STICKY (net
// held-vs-always-switch on the routing event log). This one measures the
// COMPACTION saving, i.e. how much smaller the cold-model re-prefill is once the
// old tool_result blocks are cleared. The routing log records EstSavedTokens per
// turn but no consumer prices it; this harness closes that gap offline, on
// reconstructed real traffic, without needing the router live in served mode.
//
// The figure is intentionally scoped to the re-prefill (input reprocessing) on
// the switch turn, with output excluded: smartsqueeze only shrinks the prefix a
// cold model must re-read, so SavingsPctReprefill = estSaved / prefixTokens is
// the honest, price-independent fraction, and ReprefillSavingUnits is its
// monetary magnitude on the served model at the cold cache-write tier.

// squeezeTokensPerByte mirrors compaction.estTokensFromBytes' ~4 chars/token
// heuristic (there is no tokenizer in the router; text-space compaction is
// model-agnostic by design). Kept local and named so the estimate is explicit.
const squeezeCharsPerToken = 4

// approxTokensFromBytes converts a byte length to an approximate token count with
// the same ~4 chars/token rule the compactor uses for EstSavedTokens, so the
// numerator (estSaved) and denominator (prefixTokens) below are on one scale.
func approxTokensFromBytes(n int) int64 {
	if n <= 0 {
		return 0
	}
	return int64(n) / squeezeCharsPerToken
}

// SqueezeTurnResult is the compaction measurement for one reconstructed switch
// turn (one conversation body compacted once).
type SqueezeTurnResult struct {
	// Messages is the number of messages in the reconstructed body.
	Messages int `json:"messages"`
	// PrefixTokensApprox is the approximate input token size of the whole prefix
	// the cold model would re-read on a switch, ~4 chars/token over the body.
	PrefixTokensApprox int64 `json:"prefix_tokens_approx"`
	// EstTokensSaved is the compactor's own estimate of prefix tokens removed
	// (pkg/compaction.Compact), i.e. what lands in routingEvent.EstSavedTokens.
	EstTokensSaved int64 `json:"est_tokens_saved"`
	// ReprefillCostRawUnits / ReprefillSavingUnits price the switch-turn re-prefill
	// (entire prefix as a cold cache-write, output excluded) before and saved by
	// compaction, in pricing.yaml units on the served model.
	ReprefillCostRawUnits float64 `json:"reprefill_cost_raw_units"`
	ReprefillSavingUnits  float64 `json:"reprefill_saving_units"`
	// SavingsPctReprefill is the fraction of the cold re-prefill compaction removes;
	// with output excluded and a single cache tier it equals estSaved/prefixTokens
	// and is price-independent.
	SavingsPctReprefill float64 `json:"savings_pct_reprefill"`
	// Changed is false when the body had no clearable older tool_result (short
	// conversation, or all tool_results within the retained window).
	Changed bool `json:"changed"`
}

// squeezeReplayOne runs the production compactor on one conversation body and
// prices the cold-model re-prefill it avoids on a switch turn. keepRecentTurns is
// the compactor's retained-message window (production default 3). price is the
// served model's pricing.yaml entry.
func squeezeReplayOne(body []byte, keepRecentTurns int, price economics.PriceEntry) (SqueezeTurnResult, error) {
	compacted, estSaved, changed, err := compaction.Compact(body, keepRecentTurns)
	if err != nil {
		return SqueezeTurnResult{}, err
	}

	// Prefix size is estimated off the RAW (pre-compaction) body so the percentage
	// denominator is the full context a cold model would otherwise re-read.
	prefixTokens := approxTokensFromBytes(len(body))

	// The switch-turn re-prefill: the whole prefix arrives as a cold cache WRITE on
	// the new model (the reprocessing smartsqueeze targets). Output is excluded so
	// the figure isolates the prefill smartsqueeze actually shrinks.
	rawCost := turnCost(0, 0, prefixTokens, 0, price)
	compactedTokens := prefixTokens - estSaved
	if compactedTokens < 0 {
		compactedTokens = 0
	}
	compactedCost := turnCost(0, 0, compactedTokens, 0, price)
	saving := rawCost - compactedCost

	var pct float64
	if rawCost > 0 {
		pct = saving / rawCost * 100
	}

	msgCount := countBodyMessages(body)
	// Guard: if the compactor changed nothing, savings are zero regardless of the
	// (unused) compacted body.
	_ = compacted

	return SqueezeTurnResult{
		Messages:              msgCount,
		PrefixTokensApprox:    prefixTokens,
		EstTokensSaved:        estSaved,
		ReprefillCostRawUnits: rawCost,
		ReprefillSavingUnits:  saving,
		SavingsPctReprefill:   pct,
		Changed:               changed,
	}, nil
}

// countBodyMessages returns the number of messages in an Anthropic body, or 0 if
// the body is malformed or has no messages array.
func countBodyMessages(body []byte) int {
	var top struct {
		Messages []json.RawMessage `json:"messages"`
	}
	if err := json.Unmarshal(body, &top); err != nil {
		return 0
	}
	return len(top.Messages)
}

// SqueezeSummary aggregates SqueezeTurnResult across many reconstructed turns.
type SqueezeSummary struct {
	// TurnsMeasured is switch turns with a non-empty body; ChangedTurns is the
	// subset where compaction actually cleared something (older tool_result present).
	TurnsMeasured int `json:"turns_measured"`
	ChangedTurns  int `json:"changed_turns"`

	TotalTokensSaved  int64 `json:"total_tokens_saved"`
	MedianTokensSaved int64 `json:"median_tokens_saved"`

	TotalReprefillSavingUnits float64 `json:"total_reprefill_saving_units"`
	// MedianSavingsPctReprefill / MeanSavingsPctReprefill summarize the fraction of
	// the cold re-prefill removed, over ChangedTurns (turns where a switch would
	// actually compact). Reporting over changed turns avoids diluting the figure
	// with short conversations that had nothing to clear.
	MedianSavingsPctReprefill float64 `json:"median_savings_pct_reprefill"`
	MeanSavingsPctReprefill   float64 `json:"mean_savings_pct_reprefill"`
}

// summarizeSqueeze folds per-turn results into a SqueezeSummary. Medians are
// nearest-rank, matching routing_stats.go.
func summarizeSqueeze(results []SqueezeTurnResult) SqueezeSummary {
	var s SqueezeSummary
	s.TurnsMeasured = len(results)

	savedChanged := make([]int64, 0, len(results))
	pctChanged := make([]float64, 0, len(results))
	var pctSum float64
	for _, r := range results {
		s.TotalTokensSaved += r.EstTokensSaved
		s.TotalReprefillSavingUnits += r.ReprefillSavingUnits
		if r.Changed {
			s.ChangedTurns++
			savedChanged = append(savedChanged, r.EstTokensSaved)
			pctChanged = append(pctChanged, r.SavingsPctReprefill)
			pctSum += r.SavingsPctReprefill
		}
	}

	s.MedianTokensSaved = medianOfInt64(savedChanged)
	s.MedianSavingsPctReprefill = medianFloat(pctChanged)
	if s.ChangedTurns > 0 {
		s.MeanSavingsPctReprefill = pctSum / float64(s.ChangedTurns)
	}
	return s
}
