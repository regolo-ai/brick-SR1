package proxy

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"testing"

	"github.com/regolo-ai/brick-SR1/apps/router/src/spatial-router/pkg/economics"
)

// bigToolResult builds a tool_result block whose content string is n bytes, used
// to make compaction savings deterministic and legible in the unit test.
func bigToolResult(id string, n int) map[string]any {
	s := make([]byte, n)
	for i := range s {
		s[i] = 'x'
	}
	return map[string]any{"type": "tool_result", "tool_use_id": id, "content": string(s)}
}

// buildBody assembles an Anthropic {model, system, messages} body from raw
// message objects, matching what applySmartSqueeze would forward.
func buildBody(t *testing.T, model string, msgs []map[string]any) []byte {
	t.Helper()
	body := map[string]any{
		"model":    model,
		"system":   "You are a helpful assistant.",
		"messages": msgs,
	}
	b, err := json.Marshal(body)
	if err != nil {
		t.Fatalf("marshal body: %v", err)
	}
	return b
}

// TestSqueezeReplayOne_PricesReprefillSaving is the deterministic unit: two large
// older tool_results plus a small recent one, keepRecent=1, must clear the two
// old ones, report a positive token/units saving, and a re-prefill percentage
// between 0 and 100.
func TestSqueezeReplayOne_PricesReprefillSaving(t *testing.T) {
	msgs := []map[string]any{
		{"role": "user", "content": []any{map[string]any{"type": "text", "text": "run the tools"}}},
		{"role": "assistant", "content": []any{map[string]any{"type": "tool_use", "id": "t1", "name": "bash", "input": map[string]any{}}}},
		{"role": "user", "content": []any{bigToolResult("t1", 4000)}},
		{"role": "assistant", "content": []any{map[string]any{"type": "tool_use", "id": "t2", "name": "bash", "input": map[string]any{}}}},
		{"role": "user", "content": []any{bigToolResult("t2", 4000)}},
		{"role": "assistant", "content": []any{map[string]any{"type": "text", "text": "done"}}},
		{"role": "user", "content": []any{bigToolResult("t3", 40)}}, // recent, small: retained
	}
	body := buildBody(t, "claude-opus-4-8", msgs)

	price := economics.PriceEntry{InputPrice: 5.0, OutputPrice: 25.0}
	res, err := squeezeReplayOne(body, 1, price)
	if err != nil {
		t.Fatalf("squeezeReplayOne: %v", err)
	}
	if !res.Changed {
		t.Fatalf("expected compaction to clear older tool_results, got changed=false")
	}
	// ~8000 bytes cleared across two blocks minus placeholders => ~2000 tokens.
	if res.EstTokensSaved < 1500 {
		t.Fatalf("expected est_tokens_saved >~1500, got %d", res.EstTokensSaved)
	}
	if res.ReprefillSavingUnits <= 0 {
		t.Fatalf("expected positive reprefill saving units, got %f", res.ReprefillSavingUnits)
	}
	if res.SavingsPctReprefill <= 0 || res.SavingsPctReprefill >= 100 {
		t.Fatalf("expected 0<pct<100, got %f", res.SavingsPctReprefill)
	}
	t.Logf("unit: prefix~%d tok, saved %d tok, %.1f%% of re-prefill, %.0f units",
		res.PrefixTokensApprox, res.EstTokensSaved, res.SavingsPctReprefill, res.ReprefillSavingUnits)
}

// TestSqueezeReplayOne_ShortConversationUnchanged: with keepRecent covering every
// message, nothing older exists to clear, so savings are zero and Changed=false.
func TestSqueezeReplayOne_ShortConversationUnchanged(t *testing.T) {
	msgs := []map[string]any{
		{"role": "user", "content": []any{bigToolResult("t1", 4000)}},
		{"role": "assistant", "content": []any{map[string]any{"type": "text", "text": "ok"}}},
	}
	body := buildBody(t, "claude-opus-4-8", msgs)
	res, err := squeezeReplayOne(body, 5, economics.PriceEntry{InputPrice: 5.0, OutputPrice: 25.0})
	if err != nil {
		t.Fatalf("squeezeReplayOne: %v", err)
	}
	if res.Changed || res.EstTokensSaved != 0 || res.ReprefillSavingUnits != 0 {
		t.Fatalf("expected no-op on short conversation, got %+v", res)
	}
}

// --- Real-transcript replay (env-gated), the Fase A report ---------------------

// transcriptMessage is the minimal shape we read from a Claude Code transcript
// line: the nested message with its role and polymorphic content.
type transcriptLine struct {
	Type        string `json:"type"`
	IsMeta      bool   `json:"isMeta"`
	IsSidechain bool   `json:"isSidechain"`
	Message     *struct {
		Role    string          `json:"role"`
		Content json.RawMessage `json:"content"`
	} `json:"message"`
}

// loadTranscriptMessages reconstructs the ordered user/assistant messages of one
// transcript as Anthropic message objects ({role, content}), skipping meta and
// sidechain lines and any message whose content is not a block array (plain
// string user prompts carry no tool_result and only add noise to the prefix).
func loadTranscriptMessages(path string) ([]map[string]any, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()

	var msgs []map[string]any
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 0, 64*1024), 16*1024*1024)
	for sc.Scan() {
		var ln transcriptLine
		if err := json.Unmarshal(sc.Bytes(), &ln); err != nil {
			continue
		}
		if ln.IsMeta || ln.IsSidechain || ln.Message == nil {
			continue
		}
		if ln.Message.Role != "user" && ln.Message.Role != "assistant" {
			continue
		}
		var blocks []json.RawMessage
		if json.Unmarshal(ln.Message.Content, &blocks) != nil || len(blocks) == 0 {
			continue // string content or empty: not a tool-bearing turn
		}
		content := make([]any, len(blocks))
		for i, b := range blocks {
			var m map[string]any
			if json.Unmarshal(b, &m) == nil {
				content[i] = m
			} else {
				content[i] = json.RawMessage(b)
			}
		}
		msgs = append(msgs, map[string]any{"role": ln.Message.Role, "content": content})
	}
	return msgs, sc.Err()
}

// TestSqueezeReplayOnRealTranscripts is the Fase A harness. It reconstructs each
// Claude Code transcript in BRICK_SQUEEZE_TRANSCRIPTS, simulates a model switch at
// four conversation checkpoints (25/50/75/100%), runs the production compactor at
// keepRecent=3 (production default), prices the avoided re-prefill on the served
// model, and prints a per-transcript + aggregate report.
//
//	LD_LIBRARY_PATH=.../candle-binding/target/release \
//	BRICK_SQUEEZE_TRANSCRIPTS=/root/.claude/projects/-root-forkGO \
//	[BRICK_SQUEEZE_MODEL=claude-opus-4-8] \
//	go test -run TestSqueezeReplayOnRealTranscripts ./pkg/proxy/ -v
func TestSqueezeReplayOnRealTranscripts(t *testing.T) {
	dir := os.Getenv("BRICK_SQUEEZE_TRANSCRIPTS")
	if dir == "" {
		t.Skip("set BRICK_SQUEEZE_TRANSCRIPTS to a dir of Claude Code *.jsonl transcripts to run the smartsqueeze replay")
	}
	files, err := filepath.Glob(filepath.Join(dir, "*.jsonl"))
	if err != nil || len(files) == 0 {
		t.Fatalf("no transcripts in %s (err=%v)", dir, err)
	}
	sort.Strings(files)

	// Served (warm) model: the pricey model a mid-conversation switch typically
	// leaves cold on the other side. Default opus; the % figure is price-independent
	// but the units are on this model.
	model := os.Getenv("BRICK_SQUEEZE_MODEL")
	if model == "" {
		model = "claude-opus-4-8"
	}
	price := loadSqueezePrice(t, model)

	const keepRecent = 3
	fractions := []float64{0.25, 0.50, 0.75, 1.0}

	var all []SqueezeTurnResult
	t.Logf("=== smartsqueeze offline replay: %d transcripts, model=%s, keepRecent=%d ===", len(files), model, keepRecent)
	t.Logf("%-40s %8s %10s %10s %8s", "transcript", "msgs", "prefixTok", "savedTok", "%repref")
	for _, fp := range files {
		msgs, err := loadTranscriptMessages(fp)
		if err != nil || len(msgs) < keepRecent+2 {
			continue // too short to have anything older than the retained window
		}
		var best SqueezeTurnResult
		for _, fr := range fractions {
			n := int(float64(len(msgs)) * fr)
			if n < keepRecent+1 {
				continue
			}
			body := buildBody(t, model, msgs[:n])
			res, err := squeezeReplayOne(body, keepRecent, price)
			if err != nil {
				continue
			}
			all = append(all, res)
			if res.SavingsPctReprefill > best.SavingsPctReprefill {
				best = res
			}
		}
		if best.Messages > 0 {
			t.Logf("%-40s %8d %10d %10d %7.1f%%",
				truncName(filepath.Base(fp)), best.Messages, best.PrefixTokensApprox, best.EstTokensSaved, best.SavingsPctReprefill)
		}
	}

	sum := summarizeSqueeze(all)
	t.Logf("--------------------------------------------------------------")
	t.Logf("turns measured: %d   (compacted something: %d)", sum.TurnsMeasured, sum.ChangedTurns)
	t.Logf("tokens saved: total=%d  median(changed)=%d", sum.TotalTokensSaved, sum.MedianTokensSaved)
	t.Logf("re-prefill saved: median=%.1f%%  mean=%.1f%% (over changed turns)", sum.MedianSavingsPctReprefill, sum.MeanSavingsPctReprefill)
	t.Logf("re-prefill saving units (model=%s): total=%.0f", model, sum.TotalReprefillSavingUnits)

	// Emit machine-readable JSON so the caller can lift it into a report.
	if out := os.Getenv("BRICK_SQUEEZE_OUT"); out != "" {
		b, _ := json.MarshalIndent(sum, "", "  ")
		if err := os.WriteFile(out, b, 0o644); err != nil {
			t.Logf("warn: could not write %s: %v", out, err)
		} else {
			t.Logf("summary JSON written to %s", out)
		}
	}
}

// loadSqueezePrice returns the pricing.yaml entry for model, from
// BRICK_SQUEEZE_PRICING if set, else a realistic built-in default.
func loadSqueezePrice(t *testing.T, model string) economics.PriceEntry {
	t.Helper()
	if p := os.Getenv("BRICK_SQUEEZE_PRICING"); p != "" {
		table, err := economics.LoadPricingTable(p)
		if err != nil {
			t.Fatalf("load pricing %s: %v", p, err)
		}
		if pe, ok := table.Price(model); ok {
			return pe
		}
		t.Logf("model %s not in %s; using default opus pricing", model, p)
	}
	// Default matches pricing.yaml opus tier (input 5 / output 25 per-token units).
	return economics.PriceEntry{InputPrice: 5.0, OutputPrice: 25.0}
}

func truncName(s string) string {
	if len(s) <= 40 {
		return s
	}
	return s[:37] + "..."
}

var _ = fmt.Sprintf
