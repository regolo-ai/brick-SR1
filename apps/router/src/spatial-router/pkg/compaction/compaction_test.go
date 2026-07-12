package compaction

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"
)

// --- helpers -----------------------------------------------------------------

// firstUserText mirrors the text-only extraction pkg/proxy uses to derive the
// sticky conversation identity: system prompt + first user turn, text blocks
// only. Used to assert the compactor never perturbs the identity.
func identityParts(t *testing.T, body []byte) (system, firstUser string) {
	t.Helper()
	var raw struct {
		System   json.RawMessage `json:"system"`
		Messages []struct {
			Role    string          `json:"role"`
			Content json.RawMessage `json:"content"`
		} `json:"messages"`
	}
	if err := json.Unmarshal(body, &raw); err != nil {
		t.Fatalf("identityParts: unmarshal: %v", err)
	}
	system = decodeText(raw.System)
	for i := range raw.Messages {
		if raw.Messages[i].Role != "user" {
			continue
		}
		if txt := decodeText(raw.Messages[i].Content); txt != "" {
			firstUser = txt
			break
		}
	}
	return system, firstUser
}

func decodeText(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var s string
	if json.Unmarshal(raw, &s) == nil {
		return s
	}
	var blocks []struct {
		Type string `json:"type"`
		Text string `json:"text"`
	}
	if json.Unmarshal(raw, &blocks) != nil {
		return ""
	}
	var texts []string
	for _, b := range blocks {
		if b.Type == "text" && b.Text != "" {
			texts = append(texts, b.Text)
		}
	}
	return strings.Join(texts, "\n")
}

// conversation with an old tool_result (big) and a recent one.
const bodyWithToolResults = `{
  "model": "brick-claude",
  "max_tokens": 4096,
  "system": "you are a helpful assistant",
  "messages": [
    {"role": "user", "content": "the first user turn"},
    {"role": "assistant", "content": [{"type": "tool_use", "id": "tu_1", "name": "read", "input": {"path": "a.go"}}]},
    {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "tu_1", "content": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"}]},
    {"role": "assistant", "content": [{"type": "text", "text": "done reading"}]},
    {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "tu_2", "content": "recent-result-should-stay-verbatim-and-long-enough-to-be-clearable"}]}
  ]
}`

// --- tests -------------------------------------------------------------------

func TestCompact_ClearsOldToolResultKeepsRecent(t *testing.T) {
	out, saved, changed, err := Compact([]byte(bodyWithToolResults), 2)
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if !changed {
		t.Fatal("expected changed=true")
	}
	if saved <= 0 {
		t.Fatalf("expected positive estTokensSaved, got %d", saved)
	}
	s := string(out)
	if strings.Contains(s, "AAAAAAAAAAAA") {
		t.Fatal("old tool_result content should have been cleared")
	}
	if !strings.Contains(s, placeholder) {
		t.Fatal("expected placeholder in output")
	}
	// Recent tool_result (within keepRecentTurns=2) must survive verbatim.
	if !strings.Contains(s, "recent-result-should-stay-verbatim") {
		t.Fatal("recent tool_result was cleared but should have been kept")
	}
	// Unrelated top-level fields preserved byte-exact.
	if !strings.Contains(s, `"max_tokens":4096`) {
		t.Fatal("max_tokens not preserved")
	}
}

func TestCompact_PreservesIdentity(t *testing.T) {
	in := []byte(bodyWithToolResults)
	out, _, _, _ := Compact(in, 2)

	sysIn, firstIn := identityParts(t, in)
	sysOut, firstOut := identityParts(t, out)
	if sysIn != sysOut {
		t.Fatalf("system changed: %q -> %q", sysIn, sysOut)
	}
	if firstIn != firstOut {
		t.Fatalf("first user turn changed: %q -> %q", firstIn, firstOut)
	}
	if firstOut != "the first user turn" {
		t.Fatalf("unexpected first user turn: %q", firstOut)
	}
}

func TestCompact_DeterministicAndIdempotent(t *testing.T) {
	in := []byte(bodyWithToolResults)
	out1, s1, c1, _ := Compact(in, 2)
	out2, s2, c2, _ := Compact(in, 2)
	if !bytes.Equal(out1, out2) || s1 != s2 || c1 != c2 {
		t.Fatal("Compact is not deterministic")
	}
	// Second pass over already-compacted output clears nothing new.
	out3, s3, c3, _ := Compact(out1, 2)
	if c3 {
		t.Fatalf("expected idempotent no-op on compacted body, got changed=true (saved=%d)", s3)
	}
	if !bytes.Equal(out3, out1) {
		t.Fatal("idempotent Compact should return input unchanged")
	}
}

func TestCompact_KeepRecentCoversAll(t *testing.T) {
	// keepRecentTurns >= message count: nothing is old enough to clear.
	out, saved, changed, _ := Compact([]byte(bodyWithToolResults), 100)
	if changed || saved != 0 {
		t.Fatalf("expected no-op when keepRecentTurns covers all, got changed=%v saved=%d", changed, saved)
	}
	if !bytes.Equal(out, []byte(bodyWithToolResults)) {
		t.Fatal("expected original body returned unchanged")
	}
}

func TestCompact_StringContentUntouched(t *testing.T) {
	body := `{"messages":[{"role":"user","content":"hello there"},{"role":"assistant","content":"hi"},{"role":"user","content":"again"}]}`
	out, saved, changed, _ := Compact([]byte(body), 0)
	if changed || saved != 0 {
		t.Fatalf("string-content messages have no tool_result; expected no-op, got changed=%v", changed)
	}
	if !bytes.Equal(out, []byte(body)) {
		t.Fatal("string content should be returned unchanged")
	}
}

func TestCompact_PreservesSiblingBlocks(t *testing.T) {
	// A user turn mixing text + image + tool_result: only tool_result cleared.
	body := `{"messages":[
      {"role":"user","content":[
        {"type":"text","text":"keep this text block intact please"},
        {"type":"image","source":{"type":"base64","data":"keepthisimagedatakeepthisimagedata"}},
        {"type":"tool_result","tool_use_id":"tu_9","content":"clear-this-long-tool-result-content-block"}
      ]},
      {"role":"user","content":"tail"},
      {"role":"user","content":"tail2"}
    ]}`
	out, _, changed, _ := Compact([]byte(body), 2)
	if !changed {
		t.Fatal("expected tool_result cleared")
	}
	s := string(out)
	if !strings.Contains(s, "keep this text block intact") {
		t.Fatal("text block was altered")
	}
	if !strings.Contains(s, "keepthisimagedata") {
		t.Fatal("image block was altered")
	}
	if strings.Contains(s, "clear-this-long-tool-result-content-block") {
		t.Fatal("tool_result content not cleared")
	}
	if !strings.Contains(s, `"tool_use_id":"tu_9"`) {
		t.Fatal("tool_result sibling field tool_use_id was dropped")
	}
}

func TestCompact_TolerantOnBadInput(t *testing.T) {
	cases := map[string]string{
		"malformed json": `{"messages": [`,
		"no messages":    `{"model":"brick-claude"}`,
		"empty messages": `{"messages":[]}`,
		"no tool_result": `{"messages":[{"role":"user","content":[{"type":"text","text":"just text here, nothing to clear"}]}]}`,
	}
	for name, body := range cases {
		t.Run(name, func(t *testing.T) {
			out, saved, changed, err := Compact([]byte(body), 0)
			if err != nil {
				t.Fatalf("expected nil err, got %v", err)
			}
			if changed || saved != 0 {
				t.Fatalf("expected no-op, got changed=%v saved=%d", changed, saved)
			}
			if !bytes.Equal(out, []byte(body)) {
				t.Fatal("expected original body returned on tolerant path")
			}
		})
	}
}

func TestCompact_TinyToolResultNotEnlarged(t *testing.T) {
	// A tool_result shorter than the placeholder must not be "cleared" (that would
	// grow the body). Three messages, keep 0 recent so all are eligible.
	body := `{"messages":[{"role":"user","content":[{"type":"tool_result","tool_use_id":"t","content":"ok"}]},{"role":"user","content":"a"},{"role":"user","content":"b"}]}`
	_, saved, changed, _ := Compact([]byte(body), 0)
	if changed || saved != 0 {
		t.Fatalf("tiny tool_result should be left alone, got changed=%v saved=%d", changed, saved)
	}
}

// buildLargeBody assembles a realistic agentic conversation: nTurns tool_use /
// tool_result pairs, each result ~resultBytes of output, plus system + first
// user turn. Approximates a Claude Code session with heavy tool traffic.
func buildLargeBody(nTurns, resultBytes int) []byte {
	var b strings.Builder
	b.WriteString(`{"model":"brick-claude","max_tokens":4096,"system":"you are a helpful coding assistant with many instructions",`)
	b.WriteString(`"messages":[{"role":"user","content":"please refactor the module and run the tests"}`)
	blob := strings.Repeat("x", resultBytes)
	for i := 0; i < nTurns; i++ {
		b.WriteString(`,{"role":"assistant","content":[{"type":"tool_use","id":"tu","name":"bash","input":{"cmd":"go test"}}]}`)
		b.WriteString(`,{"role":"user","content":[{"type":"tool_result","tool_use_id":"tu","content":"` + blob + `"}]}`)
	}
	b.WriteString(`]}`)
	return []byte(b.String())
}

// BenchmarkCompact measures Tier-1 compaction latency on a large body (~1MB,
// the scale of a long Claude Code context). Answers the "how long does it take"
// question empirically. Run: go test -bench BenchmarkCompact -benchmem ./pkg/compaction/
func BenchmarkCompact(b *testing.B) {
	body := buildLargeBody(120, 8000) // ~1MB, 120 tool_result blocks
	b.ReportAllocs()
	b.SetBytes(int64(len(body)))
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if _, _, changed, _ := Compact(body, 3); !changed {
			b.Fatal("expected compaction to change the large body")
		}
	}
}
