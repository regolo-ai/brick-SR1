package proxy

import (
	"strings"
	"testing"
)

// TestAggregateRoutingEvents checks the per-mode summarization: distinct
// sessions, held-turn detection (candidate != served), nearest-rank latency
// percentiles, and overall vs held median switch delta. A malformed line is
// skipped rather than aborting the aggregate.
func TestAggregateRoutingEvents(t *testing.T) {
	log := strings.Join([]string{
		`{"mode":"sticky","session_key":"s1","candidate_model":"claude-haiku-4-5","served_model":"claude-opus-4-8","est_switch_delta_price_units":5.0,"e2e_latency_ms":100}`,
		`{"mode":"sticky","session_key":"s1","candidate_model":"claude-opus-4-8","served_model":"claude-opus-4-8","est_switch_delta_price_units":0,"e2e_latency_ms":200}`,
		`{"mode":"sticky","session_key":"s2","candidate_model":"claude-haiku-4-5","served_model":"claude-haiku-4-5","est_switch_delta_price_units":1.0,"e2e_latency_ms":300}`,
		`{ this is not json }`,
		`{"mode":"off","session_key":"s3","candidate_model":"claude-haiku-4-5","served_model":"claude-haiku-4-5","est_switch_delta_price_units":0,"e2e_latency_ms":50}`,
		``,
	}, "\n")

	got := aggregateRoutingEvents(strings.NewReader(log))

	if got.TotalRequests != 4 {
		t.Fatalf("total_requests = %d, want 4 (malformed line skipped)", got.TotalRequests)
	}
	if got.TotalSessions != 3 {
		t.Fatalf("total_sessions = %d, want 3 (s1,s2,s3)", got.TotalSessions)
	}
	if len(got.Modes) != 2 {
		t.Fatalf("got %d modes, want 2 (off,sticky)", len(got.Modes))
	}

	// Modes are sorted alphabetically: off, sticky.
	off, sticky := got.Modes[0], got.Modes[1]
	if off.Mode != "off" || sticky.Mode != "sticky" {
		t.Fatalf("mode order = %q,%q, want off,sticky", off.Mode, sticky.Mode)
	}

	if sticky.Requests != 3 || sticky.Sessions != 2 || sticky.HeldRequests != 1 {
		t.Fatalf("sticky agg = req %d sess %d held %d, want 3/2/1", sticky.Requests, sticky.Sessions, sticky.HeldRequests)
	}
	// latencies [100,200,300]: nearest-rank p50 -> 200, p95 -> 300.
	if sticky.LatencyP50Ms != 200 || sticky.LatencyP95Ms != 300 {
		t.Fatalf("sticky latency p50/p95 = %d/%d, want 200/300", sticky.LatencyP50Ms, sticky.LatencyP95Ms)
	}
	// deltas [0,1,5] -> median 1.0; held-only [5] -> 5.0.
	if sticky.MedianSwitchDelta != 1.0 || sticky.MedianSwitchDeltaHeld != 5.0 {
		t.Fatalf("sticky median delta/held = %.2f/%.2f, want 1.00/5.00", sticky.MedianSwitchDelta, sticky.MedianSwitchDeltaHeld)
	}

	if off.Requests != 1 || off.Sessions != 1 || off.HeldRequests != 0 {
		t.Fatalf("off agg = req %d sess %d held %d, want 1/1/0", off.Requests, off.Sessions, off.HeldRequests)
	}
	if off.LatencyP50Ms != 50 || off.MedianSwitchDeltaHeld != 0 {
		t.Fatalf("off p50/held-median = %d/%.2f, want 50/0.00", off.LatencyP50Ms, off.MedianSwitchDeltaHeld)
	}
}

// TestMergeReplayIntoStats checks that the net-total counterfactual (from
// replay.go) is merged into the per-mode stats when a pricing table is
// available, alongside (not replacing) the prefix-only MedianSwitchDeltaHeld.
func TestMergeReplayIntoStats(t *testing.T) {
	table := writeReplayPricing(t)
	// Same held turn as TestReplayHeldTurnStickyCheaper: sticky (opus) cheaper
	// than the no-sticky (haiku) counterfactual on a 100k-token cached prefix.
	log := `{"mode":"sticky","session_key":"s1","candidate_model":"claude-haiku-4-5","served_model":"claude-opus-4-8","fresh_input_tokens":0,"cache_read_tokens":100000,"cache_creation_tokens":0,"output_tokens":10,"est_switch_delta_price_units":100000,"e2e_latency_ms":10}`

	resp := aggregateRoutingEvents(strings.NewReader(log))
	mergeReplayIntoStats(&resp, replayCounterfactual(strings.NewReader(log), table))

	if len(resp.Modes) != 1 {
		t.Fatalf("got %d modes, want 1", len(resp.Modes))
	}
	m := resp.Modes[0]
	if m.MedianSwitchDeltaHeld != 100000 {
		t.Fatalf("prefix-only median held = %.0f, want 100000 (unaffected by merge)", m.MedianSwitchDeltaHeld)
	}
	if m.PricedRequests != 1 || m.HeldTurnsSticky != 1 || m.HeldTurnsWorse != 0 {
		t.Fatalf("priced %d cheaper %d worse %d, want 1/1/0", m.PricedRequests, m.HeldTurnsSticky, m.HeldTurnsWorse)
	}
	if m.NetUnits == nil || *m.NetUnits >= 0 {
		t.Fatalf("net_units = %v, want a populated negative value (sticky cheaper)", m.NetUnits)
	}
	if m.SavingsPct == nil {
		t.Fatal("savings_pct should be populated when priced_turns > 0")
	}
}

// TestMergeReplayIntoStats_NoPricingLeavesNetNil checks that when the log has
// no enriched (priced) turns for a mode, the net fields stay nil rather than
// silently reporting a misleading zero.
func TestMergeReplayIntoStats_NoPricingLeavesNetNil(t *testing.T) {
	table := writeReplayPricing(t)
	// Legacy pre-enrichment record: no token breakdown, so PricedTurns stays 0.
	log := `{"mode":"sticky","session_key":"s1","candidate_model":"claude-haiku-4-5","served_model":"claude-opus-4-8","ctx_tokens":40000,"est_switch_delta_price_units":1234.5,"e2e_latency_ms":10}`

	resp := aggregateRoutingEvents(strings.NewReader(log))
	mergeReplayIntoStats(&resp, replayCounterfactual(strings.NewReader(log), table))

	m := resp.Modes[0]
	if m.NetUnits != nil || m.SavingsPct != nil {
		t.Fatalf("net fields should stay nil on legacy (unpriced) turns, got net=%v pct=%v", m.NetUnits, m.SavingsPct)
	}
	if m.MedianSwitchDeltaHeld != 1234.5 {
		t.Fatalf("prefix-only median held = %.1f, want 1234.5 (still the honest fallback)", m.MedianSwitchDeltaHeld)
	}
}

// TestAggregateRoutingEvents_SmartsqueezeSavings checks that est_saved_tokens is
// aggregated per mode: only turns with est_saved_tokens > 0 count as squeeze
// turns, the total/median are correct, and priceSqueezeSavings prices the total
// as a cold cache-write re-prefill on the mode's most-served model.
func TestAggregateRoutingEvents_SmartsqueezeSavings(t *testing.T) {
	log := strings.Join([]string{
		`{"mode":"smartsqueeze","session_key":"s1","candidate_model":"claude-haiku-4-5","served_model":"claude-opus-4-8","est_saved_tokens":1000,"e2e_latency_ms":100}`,
		`{"mode":"smartsqueeze","session_key":"s1","candidate_model":"claude-opus-4-8","served_model":"claude-opus-4-8","est_saved_tokens":3000,"e2e_latency_ms":120}`,
		// no switch, nothing compacted -> est_saved_tokens absent: not a squeeze turn.
		`{"mode":"smartsqueeze","session_key":"s2","candidate_model":"claude-opus-4-8","served_model":"claude-opus-4-8","est_switch_delta_price_units":0,"e2e_latency_ms":80}`,
	}, "\n")

	resp := aggregateRoutingEvents(strings.NewReader(log))
	if len(resp.Modes) != 1 {
		t.Fatalf("got %d modes, want 1 (smartsqueeze)", len(resp.Modes))
	}
	m := resp.Modes[0]
	if m.SqueezeTurns != 2 {
		t.Fatalf("squeeze_turns = %d, want 2 (only est_saved>0)", m.SqueezeTurns)
	}
	if m.EstTokensSavedTotal != 4000 {
		t.Fatalf("est_tokens_saved_total = %d, want 4000", m.EstTokensSavedTotal)
	}
	// nearest-rank median of [1000,3000] -> index 1 -> 3000.
	if m.EstTokensSavedMedian != 3000 {
		t.Fatalf("est_tokens_saved_median = %d, want 3000", m.EstTokensSavedMedian)
	}
	if m.refServedModel != "claude-opus-4-8" {
		t.Fatalf("refServedModel = %q, want claude-opus-4-8 (most served)", m.refServedModel)
	}

	// Price it: 4000 tokens as cold cache-write (1.25x) on opus (input 5.0) =>
	// 4000 * 1.25 * 5.0 = 25000 units.
	table := writeReplayPricing(t)
	priceSqueezeSavings(&resp, table)
	if resp.Modes[0].EstUnitsSaved == nil {
		t.Fatal("squeeze_est_units_saved should be priced when tokens saved > 0")
	}
	if got := *resp.Modes[0].EstUnitsSaved; got != 25000 {
		t.Fatalf("squeeze_est_units_saved = %.1f, want 25000", got)
	}
}

// TestPriceSqueezeSavings_NoTokensLeavesUnitsNil ensures a mode that compacted
// nothing keeps EstUnitsSaved nil (a missing figure, not a real zero).
func TestPriceSqueezeSavings_NoTokensLeavesUnitsNil(t *testing.T) {
	log := `{"mode":"sticky","session_key":"s1","candidate_model":"claude-haiku-4-5","served_model":"claude-opus-4-8","est_switch_delta_price_units":5.0,"e2e_latency_ms":100}`
	resp := aggregateRoutingEvents(strings.NewReader(log))
	priceSqueezeSavings(&resp, writeReplayPricing(t))
	if resp.Modes[0].EstUnitsSaved != nil {
		t.Fatalf("est_units_saved should stay nil with no compaction, got %v", resp.Modes[0].EstUnitsSaved)
	}
}
