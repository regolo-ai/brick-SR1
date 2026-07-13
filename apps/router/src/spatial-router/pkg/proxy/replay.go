package proxy

import (
	"bufio"
	"encoding/json"
	"io"
	"sort"

	"github.com/regolo-ai/brick-SR1/apps/router/src/spatial-router/pkg/economics"
)

// This file is the offline counterfactual replay: given the append-only routing
// event log, it answers "did sticky routing actually consume less?" by pricing
// each turn twice on the SAME traffic — once as it was really served, and once
// under the no-sticky policy (always switch to the router's candidate) — and
// summing the difference.
//
// It is read-only and never runs on the request path: it consumes the JSONL log
// that forwardAnthropicRequest writes after the response has already streamed.
//
// The honest number this produces, that the live /api/v1/routing/stats does not,
// is the NET total: the prompt-cache reprocessing a hold avoided, MINUS the extra
// cost of keeping a pricier model warm for the rest of the turn (output included).
// median_switch_delta_price_units_held reports only the first half, so it reads
// optimistically; this reconciles both sides on real traffic.
//
// Assumption (held-token-parity): the counterfactual branch reprices the SAME
// token counts on the candidate model. It does not simulate the different reply
// the candidate would have produced (different length, different follow-on cache
// state). This is a first-order price comparison, not a response simulation, and
// is stated so the figure is not overread. The one token count that DOES change
// between branches is the cached prefix: served as a cache READ on the held model
// (what really happened), it would have been a cache WRITE on the candidate (the
// switch the hold avoided) — that asymmetry is the whole point and is modelled.

// turnCost is the priced cost of one turn on one model, in absolute price-yaml
// units (input_price/output_price are per-token in whatever unit pricing.yaml
// uses; only ratios and sums matter downstream). cacheRead prefix is billed at
// the read multiplier, cacheWrite prefix at the write multiplier, matching the
// same constants the live economics endpoint uses (economics.go).
func turnCost(freshIn, cacheReadIn, cacheWriteIn, out int64, in economics.PriceEntry) float64 {
	inputUnits := float64(freshIn) +
		cacheReadInputPriceMultiplier*float64(cacheReadIn) +
		cacheWriteInputPriceMultiplier*float64(cacheWriteIn)
	return inputUnits*in.InputPrice + float64(out)*in.OutputPrice
}

// ReplayModeSummary is the counterfactual result for one routing mode.
type ReplayModeSummary struct {
	Mode string `json:"mode"`
	// Turns is every routed event in this mode; PricedTurns is the subset that
	// carried the enriched per-turn token breakdown and both models' prices, i.e.
	// the turns the net-total comparison could actually run on.
	Turns      int `json:"turns"`
	PricedTurns int `json:"priced_turns"`
	// HeldTurns is turns where sticky served a different (warmer) model than the
	// candidate — the only turns where the two branches diverge. On a held turn
	// the net can be negative (sticky cheaper: avoided a costly cache rewrite) or
	// positive (sticky pricier: the held model's per-token rate outweighed it).
	HeldTurns       int `json:"held_turns"`
	HeldTurnsSticky int `json:"held_turns_where_sticky_cheaper"`
	HeldTurnsWorse  int `json:"held_turns_where_sticky_costlier"`

	// StickyCostUnits / NoStickyCostUnits are the total priced cost of PricedTurns
	// under each policy; NetUnits = sticky - no-sticky (negative = sticky saved).
	StickyCostUnits   float64 `json:"sticky_cost_units"`
	NoStickyCostUnits float64 `json:"no_sticky_cost_units"`
	NetUnits          float64 `json:"net_units_sticky_minus_no_sticky"`
	SavingsPct        float64 `json:"savings_pct"`

	// PrefixOnlyDeltaUnits is the fallback figure computed from EstSwitchDelta
	// (the prefix-reprocessing cost a hold avoided), summed over held turns. It is
	// what CAN be computed from pre-enrichment log records that lack the token
	// breakdown, and is reported alongside the net so the two are never confused.
	// For enriched turns it is the prefix half of NetUnits; for legacy turns it is
	// the only available signal. Positive = cost avoided by holding.
	PrefixOnlyAvoidedUnits float64 `json:"prefix_only_avoided_units"`
}

// ReplaySummary is the full replay result across all modes.
type ReplaySummary struct {
	Modes       []ReplayModeSummary `json:"modes"`
	TotalTurns  int                 `json:"total_turns"`
	TotalPriced int                 `json:"total_priced_turns"`
	// Partial is set when at least one turn lacked the enriched token breakdown,
	// so the net-total figure covers only a subset and PrefixOnlyAvoidedUnits is
	// the honest signal for the rest (pre-enrichment historical log).
	Partial bool   `json:"partial"`
	Note    string `json:"note,omitempty"`
}

// replayModeAcc accumulates one mode before summarization.
type replayModeAcc struct {
	turns, priced, held, stickyCheaper, stickyWorse int
	stickyCost, noStickyCost, prefixAvoided         float64
}

// replayCounterfactual parses a JSONL routing event stream and, for every turn
// with both models known, prices it on the served model (what happened) and on
// the candidate model (the no-sticky counterfactual), summing the net per mode.
//
// A turn is "priced" (contributes to the net total) only when it carries the
// enriched token breakdown (FreshInputTokens/CacheReadTokens/... > 0 available,
// detected via a nonzero CtxTokens with the breakdown present) AND both models
// resolve in the pricing table. Turns missing either fall back to the prefix-only
// avoided figure from EstSwitchDelta, and flip Partial to true.
//
// Malformed lines are skipped, mirroring aggregateRoutingEvents, so the replay is
// safe to point at a live, still-growing log.
func replayCounterfactual(r io.Reader, table *economics.PricingTable) ReplaySummary {
	byMode := map[string]*replayModeAcc{}
	total := 0
	partial := false

	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 0, 64*1024), 4*1024*1024)
	for sc.Scan() {
		line := sc.Bytes()
		if len(line) == 0 {
			continue
		}
		var ev routingEvent
		if err := json.Unmarshal(line, &ev); err != nil {
			continue
		}
		total++
		acc := byMode[ev.Mode]
		if acc == nil {
			acc = &replayModeAcc{}
			byMode[ev.Mode] = acc
		}
		acc.turns++

		held := ev.CandidateModel != "" && ev.ServedModel != "" && ev.CandidateModel != ev.ServedModel
		if held {
			acc.held++
			// Prefix-only avoided cost is available on every held record (legacy or
			// enriched): it is exactly what the live stats endpoint medianizes.
			acc.prefixAvoided += ev.EstSwitchDelta
		}

		// Net total needs the enriched breakdown and both prices. The breakdown is
		// considered present when the fresh/cache/output components are populated;
		// CtxTokens alone (legacy) is not enough because it does not separate the
		// cache tiers that price differently between read (stay) and write (switch).
		hasBreakdown := ev.FreshInputTokens != 0 || ev.CacheReadTokens != 0 || ev.CacheCreationTokens != 0 || ev.OutputTokens != 0
		if table == nil || !hasBreakdown || ev.ServedModel == "" || ev.CandidateModel == "" {
			if !hasBreakdown {
				partial = true
			}
			continue
		}
		servedPrice, okS := table.Price(ev.ServedModel)
		candPrice, okC := table.Price(ev.CandidateModel)
		if !okS || !okC {
			partial = true
			continue
		}

		// Sticky (real): the turn as served. The cached prefix was a cache READ on
		// the served model.
		stickyCost := turnCost(ev.FreshInputTokens, ev.CacheReadTokens, ev.CacheCreationTokens, ev.OutputTokens, servedPrice)

		// No-sticky (counterfactual): the same turn served by the candidate. When
		// the two models differ (a held turn), the prefix that was a cache read on
		// the warm model would instead be a cache WRITE on the cold candidate — the
		// reprocessing the hold avoided. So the cache-read tokens move into the
		// cache-write column. When candidate == served (no hold), the two branches
		// are identical by construction and net to zero.
		var noStickyCost float64
		if held {
			noStickyCost = turnCost(ev.FreshInputTokens, 0, ev.CacheReadTokens+ev.CacheCreationTokens, ev.OutputTokens, candPrice)
		} else {
			noStickyCost = turnCost(ev.FreshInputTokens, ev.CacheReadTokens, ev.CacheCreationTokens, ev.OutputTokens, candPrice)
		}

		acc.priced++
		acc.stickyCost += stickyCost
		acc.noStickyCost += noStickyCost
		if held {
			if stickyCost < noStickyCost {
				acc.stickyCheaper++
			} else if stickyCost > noStickyCost {
				acc.stickyWorse++
			}
		}
	}

	modes := make([]ReplayModeSummary, 0, len(byMode))
	totalPriced := 0
	for mode, acc := range byMode {
		net := acc.stickyCost - acc.noStickyCost
		var pct float64
		if acc.noStickyCost > 0 {
			pct = (1 - acc.stickyCost/acc.noStickyCost) * 100
		}
		totalPriced += acc.priced
		modes = append(modes, ReplayModeSummary{
			Mode:                   mode,
			Turns:                  acc.turns,
			PricedTurns:            acc.priced,
			HeldTurns:              acc.held,
			HeldTurnsSticky:        acc.stickyCheaper,
			HeldTurnsWorse:         acc.stickyWorse,
			StickyCostUnits:        acc.stickyCost,
			NoStickyCostUnits:      acc.noStickyCost,
			NetUnits:               net,
			SavingsPct:             pct,
			PrefixOnlyAvoidedUnits: acc.prefixAvoided,
		})
	}
	sort.Slice(modes, func(i, j int) bool { return modes[i].Mode < modes[j].Mode })

	note := ""
	if partial {
		note = "some turns lacked the enriched token breakdown (pre-enrichment log); net-total covers priced_turns only, prefix_only_avoided_units is the honest signal for the rest"
	}
	return ReplaySummary{
		Modes:       modes,
		TotalTurns:  total,
		TotalPriced: totalPriced,
		Partial:     partial,
		Note:        note,
	}
}
