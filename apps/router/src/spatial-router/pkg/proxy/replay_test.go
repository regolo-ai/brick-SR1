package proxy

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/regolo-ai/brick-SR1/apps/router/src/spatial-router/pkg/economics"
)

// writeReplayPricing writes a minimal pricing.yaml with haiku/opus and returns a
// loaded table. Prices mirror the real pricing.yaml ratios (haiku in=1 out=5,
// opus in=5 out=25) so the arithmetic in the assertions is easy to verify.
func writeReplayPricing(t *testing.T) *economics.PricingTable {
	t.Helper()
	path := filepath.Join(t.TempDir(), "pricing.yaml")
	yaml := `- provider: anthropic
  model: claude-haiku
  input_price: 1.0
  output_price: 5.0
  currency: USD
- provider: anthropic
  model: claude-opus
  input_price: 5.0
  output_price: 25.0
  currency: USD
`
	if err := os.WriteFile(path, []byte(yaml), 0o644); err != nil {
		t.Fatalf("write pricing: %v", err)
	}
	table, err := economics.LoadPricingTable(path)
	if err != nil {
		t.Fatalf("load pricing: %v", err)
	}
	return table
}

// TestReplayHeldTurnStickyCheaper: a held turn where sticky served opus (warm)
// against a haiku candidate, with a large cached prefix. Holding opus reads the
// prefix cheap (0.10*5=0.5/token); switching to haiku would have cache-WRITTEN
// the whole prefix (1.25*1=1.25/token). With a big prefix and little else, the
// switch is more expensive, so sticky is the cheaper branch (net < 0).
func TestReplayHeldTurnStickyCheaper(t *testing.T) {
	table := writeReplayPricing(t)
	// prefix = 100000 cache-read tokens on opus, no fresh input, tiny output.
	log := `{"mode":"sticky","session_key":"s1","candidate_model":"claude-haiku-4-5","served_model":"claude-opus-4-8","fresh_input_tokens":0,"cache_read_tokens":100000,"cache_creation_tokens":0,"output_tokens":10,"est_switch_delta_price_units":100000}`

	got := replayCounterfactual(strings.NewReader(log), table)
	if len(got.Modes) != 1 {
		t.Fatalf("got %d modes, want 1", len(got.Modes))
	}
	m := got.Modes[0]
	// sticky (opus, prefix as read): 0.10*100000*5 = 50000 input + 10*25 = 250 -> 50250
	// no-sticky (haiku, prefix as write): 1.25*100000*1 = 125000 input + 10*5 = 50 -> 125050
	if m.StickyCostUnits != 50250 || m.NoStickyCostUnits != 125050 {
		t.Fatalf("costs = sticky %.0f / nosticky %.0f, want 50250 / 125050", m.StickyCostUnits, m.NoStickyCostUnits)
	}
	if m.NetUnits >= 0 {
		t.Fatalf("net = %.0f, want negative (sticky cheaper)", m.NetUnits)
	}
	if m.HeldTurns != 1 || m.HeldTurnsSticky != 1 || m.HeldTurnsWorse != 0 {
		t.Fatalf("held = %d cheaper %d worse %d, want 1/1/0", m.HeldTurns, m.HeldTurnsSticky, m.HeldTurnsWorse)
	}
	if m.PrefixOnlyAvoidedUnits != 100000 {
		t.Fatalf("prefix_only_avoided = %.0f, want 100000 (est_switch_delta)", m.PrefixOnlyAvoidedUnits)
	}
}

// TestReplayHeldTurnStickyCostlier: a held turn where the prefix is small but the
// turn generates a lot of OUTPUT on the expensive held model. Holding opus bills
// output at 25/token; the haiku candidate would have billed 5/token. With a small
// prefix the avoided cache-write does not offset the output premium, so sticky is
// the costlier branch (net > 0) — the trade-off the live stats endpoint hides.
func TestReplayHeldTurnStickyCostlier(t *testing.T) {
	table := writeReplayPricing(t)
	// tiny prefix (1000 read), big output (5000) on opus vs haiku candidate.
	log := `{"mode":"sticky","session_key":"s1","candidate_model":"claude-haiku-4-5","served_model":"claude-opus-4-8","fresh_input_tokens":0,"cache_read_tokens":1000,"cache_creation_tokens":0,"output_tokens":5000,"est_switch_delta_price_units":1000}`

	got := replayCounterfactual(strings.NewReader(log), table)
	m := got.Modes[0]
	// sticky (opus): 0.10*1000*5 = 500 + 5000*25 = 125000 -> 125500
	// no-sticky (haiku): 1.25*1000*1 = 1250 + 5000*5 = 25000 -> 26250
	if m.StickyCostUnits != 125500 || m.NoStickyCostUnits != 26250 {
		t.Fatalf("costs = sticky %.0f / nosticky %.0f, want 125500 / 26250", m.StickyCostUnits, m.NoStickyCostUnits)
	}
	if m.NetUnits <= 0 {
		t.Fatalf("net = %.0f, want positive (sticky costlier)", m.NetUnits)
	}
	if m.HeldTurnsWorse != 1 || m.HeldTurnsSticky != 0 {
		t.Fatalf("held worse %d cheaper %d, want 1/0", m.HeldTurnsWorse, m.HeldTurnsSticky)
	}
}

// TestReplayUnheldTurnNetsZero: when candidate == served (no hold), the two
// branches are identical by construction, so the turn contributes zero net and
// is not counted as held.
func TestReplayUnheldTurnNetsZero(t *testing.T) {
	table := writeReplayPricing(t)
	log := `{"mode":"sticky","session_key":"s1","candidate_model":"claude-opus-4-8","served_model":"claude-opus-4-8","fresh_input_tokens":100,"cache_read_tokens":5000,"cache_creation_tokens":0,"output_tokens":200,"est_switch_delta_price_units":0}`

	got := replayCounterfactual(strings.NewReader(log), table)
	m := got.Modes[0]
	if m.NetUnits != 0 {
		t.Fatalf("unheld net = %.4f, want 0", m.NetUnits)
	}
	if m.HeldTurns != 0 || m.PricedTurns != 1 {
		t.Fatalf("held %d priced %d, want 0/1", m.HeldTurns, m.PricedTurns)
	}
}

// TestReplayLegacyRecordIsPartial: a pre-enrichment record (only CtxTokens, no
// breakdown) cannot be net-priced; it must fall back to the prefix-only avoided
// figure and flip Partial. Its held prefix cost still lands in the fallback sum.
func TestReplayLegacyRecordIsPartial(t *testing.T) {
	table := writeReplayPricing(t)
	log := `{"mode":"sticky","session_key":"s1","candidate_model":"claude-haiku-4-5","served_model":"claude-opus-4-8","ctx_tokens":40000,"est_switch_delta_price_units":1234.5}`

	got := replayCounterfactual(strings.NewReader(log), table)
	if !got.Partial || got.Note == "" {
		t.Fatalf("legacy record should mark Partial with a note, got %+v", got)
	}
	m := got.Modes[0]
	if m.PricedTurns != 0 {
		t.Fatalf("legacy priced_turns = %d, want 0", m.PricedTurns)
	}
	if m.HeldTurns != 1 || m.PrefixOnlyAvoidedUnits != 1234.5 {
		t.Fatalf("held %d prefix_avoided %.1f, want 1 / 1234.5", m.HeldTurns, m.PrefixOnlyAvoidedUnits)
	}
}

// TestReplayMalformedLineSkipped: a bad JSON line is skipped, not fatal.
func TestReplayMalformedLineSkipped(t *testing.T) {
	table := writeReplayPricing(t)
	log := strings.Join([]string{
		`{"mode":"sticky","candidate_model":"claude-opus-4-8","served_model":"claude-opus-4-8","fresh_input_tokens":10,"output_tokens":5}`,
		`{ not json }`,
		``,
	}, "\n")
	got := replayCounterfactual(strings.NewReader(log), table)
	if got.TotalTurns != 1 {
		t.Fatalf("total_turns = %d, want 1 (malformed skipped)", got.TotalTurns)
	}
}

// TestReplayOnRealLog is an opt-in end-to-end run against the real routing event
// log copied out of the router container. It is skipped unless BRICK_REPLAY_LOG
// points at a JSONL file, and BRICK_REPLAY_PRICING (optional) at a pricing.yaml
// (falling back to a haiku/opus/sonnet/fable default). It prints the per-mode net
// so the "does sticky consume less" question gets a concrete number on real
// traffic, without adding any CLI/endpoint surface.
//
//	BRICK_REPLAY_LOG=/path/routing_events.jsonl \
//	BRICK_REPLAY_PRICING=/path/pricing.yaml \
//	go test -run TestReplayOnRealLog ./pkg/proxy/ -v
func TestReplayOnRealLog(t *testing.T) {
	logPath := os.Getenv("BRICK_REPLAY_LOG")
	if logPath == "" {
		t.Skip("set BRICK_REPLAY_LOG=/path/routing_events.jsonl to run the real-log replay")
	}
	f, err := os.Open(logPath)
	if err != nil {
		t.Fatalf("open real log %q: %v", logPath, err)
	}
	defer f.Close()

	var table *economics.PricingTable
	if p := os.Getenv("BRICK_REPLAY_PRICING"); p != "" {
		table, err = economics.LoadPricingTable(p)
		if err != nil {
			t.Fatalf("load pricing %q: %v", p, err)
		}
	} else {
		table = writeRealisticPricing(t)
	}

	sum := replayCounterfactual(f, table)
	t.Logf("replay over %d turns (%d priced, partial=%v)", sum.TotalTurns, sum.TotalPriced, sum.Partial)
	if sum.Note != "" {
		t.Logf("note: %s", sum.Note)
	}
	for _, m := range sum.Modes {
		t.Logf("mode=%s turns=%d priced=%d held=%d (sticky_cheaper=%d costlier=%d) net_units=%.1f savings=%.2f%% prefix_only_avoided=%.1f",
			m.Mode, m.Turns, m.PricedTurns, m.HeldTurns, m.HeldTurnsSticky, m.HeldTurnsWorse,
			m.NetUnits, m.SavingsPct, m.PrefixOnlyAvoidedUnits)
	}
}

// writeRealisticPricing mirrors the production pricing.yaml (haiku/sonnet/opus/
// fable) for the real-log replay when no BRICK_REPLAY_PRICING is supplied.
func writeRealisticPricing(t *testing.T) *economics.PricingTable {
	t.Helper()
	path := filepath.Join(t.TempDir(), "pricing.yaml")
	yaml := `- {provider: anthropic, model: claude-haiku, input_price: 1.0, output_price: 5.0, currency: USD}
- {provider: anthropic, model: claude-sonnet, input_price: 3.0, output_price: 15.0, currency: USD}
- {provider: anthropic, model: claude-opus, input_price: 5.0, output_price: 25.0, currency: USD}
- {provider: anthropic, model: claude-fable, input_price: 10.0, output_price: 50.0, currency: USD}
`
	if err := os.WriteFile(path, []byte(yaml), 0o644); err != nil {
		t.Fatalf("write pricing: %v", err)
	}
	table, err := economics.LoadPricingTable(path)
	if err != nil {
		t.Fatalf("load pricing: %v", err)
	}
	return table
}
