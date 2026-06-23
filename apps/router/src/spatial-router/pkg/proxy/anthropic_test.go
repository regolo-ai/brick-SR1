package proxy

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestExtractAnthropicPromptText_StringContent(t *testing.T) {
	body := []byte(`{"model":"claude-opus-4-7","messages":[{"role":"user","content":"hello world"}]}`)
	got := extractAnthropicPromptText(body)
	if got != "hello world" {
		t.Fatalf("got %q want %q", got, "hello world")
	}
}

func TestExtractAnthropicPromptText_BlockContent(t *testing.T) {
	body := []byte(`{"model":"x","messages":[{"role":"user","content":[{"type":"text","text":"part1"},{"type":"image","source":{}},{"type":"text","text":"part2"}]}]}`)
	got := extractAnthropicPromptText(body)
	if !strings.Contains(got, "part1") || !strings.Contains(got, "part2") {
		t.Fatalf("expected both text parts, got %q", got)
	}
}

func TestExtractAnthropicPromptText_SystemPlusUser(t *testing.T) {
	body := []byte(`{"system":"you are a helper","messages":[{"role":"assistant","content":"prev"},{"role":"user","content":"latest question"}]}`)
	got := extractAnthropicPromptText(body)
	if !strings.Contains(got, "you are a helper") || !strings.Contains(got, "latest question") {
		t.Fatalf("expected system+user, got %q", got)
	}
	if strings.Contains(got, "prev") {
		t.Fatalf("should not include assistant turn, got %q", got)
	}
}

func TestExtractAnthropicPromptText_UsesLastUserOnly(t *testing.T) {
	body := []byte(`{"messages":[{"role":"user","content":"first"},{"role":"assistant","content":"a"},{"role":"user","content":"second"}]}`)
	got := extractAnthropicPromptText(body)
	if !strings.Contains(got, "second") || strings.Contains(got, "first") {
		t.Fatalf("expected only latest user message, got %q", got)
	}
}

func TestExtractAnthropicContextText_LastKTurns(t *testing.T) {
	body := []byte(`{"system":"sys","messages":[` +
		`{"role":"user","content":"u1"},` +
		`{"role":"assistant","content":"a1"},` +
		`{"role":"user","content":"u2"},` +
		`{"role":"assistant","content":"a2"},` +
		`{"role":"user","content":"u3"}]}`)
	got := extractAnthropicContextText(body, 3)
	// Last 3 turns: a1, u2, a2, u3 -> trimmed to 3 most recent: u2, a2, u3.
	for _, want := range []string{"sys", "u2", "a2", "u3"} {
		if !strings.Contains(got, want) {
			t.Fatalf("expected %q in context window, got %q", want, got)
		}
	}
	if strings.Contains(got, "u1") || strings.Contains(got, "a1") {
		t.Fatalf("turns beyond k should be excluded, got %q", got)
	}
	// Chronological order: u2 before a2 before u3.
	if !(strings.Index(got, "u2") < strings.Index(got, "a2") && strings.Index(got, "a2") < strings.Index(got, "u3")) {
		t.Fatalf("turns should be chronological, got %q", got)
	}
}

func TestExtractAnthropicContextText_FallsBackForSmallK(t *testing.T) {
	body := []byte(`{"messages":[{"role":"user","content":"first"},{"role":"assistant","content":"a"},{"role":"user","content":"second"}]}`)
	got := extractAnthropicContextText(body, 1)
	if !strings.Contains(got, "second") || strings.Contains(got, "first") {
		t.Fatalf("k<=1 should fall back to last-user-only, got %q", got)
	}
}

func TestExtractAnthropicContextText_TruncatesTail(t *testing.T) {
	long := strings.Repeat("x", maxContextClassifyChars+5000)
	body := []byte(`{"messages":[{"role":"user","content":"` + long + `"},{"role":"user","content":"tail-marker"}]}`)
	got := extractAnthropicContextText(body, 4)
	if len([]rune(got)) > maxContextClassifyChars {
		t.Fatalf("context window not truncated: %d runes", len([]rune(got)))
	}
	if !strings.Contains(got, "tail-marker") {
		t.Fatalf("truncation should keep the trailing (most recent) text, got tail missing")
	}
}

func TestRewriteModelInBodyPreservesUnknownFields(t *testing.T) {
	body := []byte(`{"model":"old","max_tokens":100,"thinking":{"type":"enabled","budget_tokens":1000},"tools":[{"name":"x"}],"messages":[{"role":"user","content":"hi"}]}`)
	out := rewriteModelInBody(body, "claude-haiku-4-5")
	var parsed map[string]interface{}
	if err := json.Unmarshal(out, &parsed); err != nil {
		t.Fatalf("rewritten body invalid JSON: %v", err)
	}
	if parsed["model"] != "claude-haiku-4-5" {
		t.Fatalf("model not rewritten: %v", parsed["model"])
	}
	if _, ok := parsed["thinking"]; !ok {
		t.Fatalf("thinking field dropped")
	}
	if _, ok := parsed["tools"]; !ok {
		t.Fatalf("tools field dropped")
	}
}

// TestStripUnsupportedFieldsForModel_HaikuRemovesThinkingControls verifies that
// for Haiku (no thinking/effort support) the router strips effort,
// output_config.effort, thinking, and the clear_thinking_20251015 context edit,
// regardless of who set them, while leaving sonnet/opus untouched.
func TestStripUnsupportedFieldsForModel_HaikuRemovesThinkingControls(t *testing.T) {
	body := []byte(`{"model":"claude-haiku-4-5","thinking":{"type":"enabled"},"output_config":{"effort":"high"},"context_management":{"edits":[{"type":"clear_thinking_20251015","keep":"all"},{"type":"clear_tool_uses_20250919"}]},"messages":[{"role":"user","content":"hi"}]}`)
	out := stripUnsupportedFieldsForModel(body, "claude-haiku-4-5")
	var parsed map[string]interface{}
	if err := json.Unmarshal(out, &parsed); err != nil {
		t.Fatalf("stripped body invalid JSON: %v", err)
	}
	if _, ok := parsed["thinking"]; ok {
		t.Fatalf("thinking should be stripped for haiku")
	}
	if _, ok := parsed["output_config"]; ok {
		t.Fatalf("emptied output_config should be dropped for haiku")
	}
	cm, ok := parsed["context_management"].(map[string]interface{})
	if !ok {
		t.Fatalf("context_management dropped but other edits remained")
	}
	edits, _ := cm["edits"].([]interface{})
	if len(edits) != 1 {
		t.Fatalf("expected 1 surviving edit, got %d", len(edits))
	}
	first, _ := edits[0].(map[string]interface{})
	if first["type"] != "clear_tool_uses_20250919" {
		t.Fatalf("clear_thinking edit was not the one removed: %v", first["type"])
	}
}

// TestStripUnsupportedFieldsForModel_SonnetUntouched ensures models that support
// thinking keep all fields, including the clear_thinking context edit.
func TestStripUnsupportedFieldsForModel_SonnetUntouched(t *testing.T) {
	body := []byte(`{"model":"claude-sonnet-4-6","context_management":{"edits":[{"type":"clear_thinking_20251015","keep":"all"}]},"messages":[{"role":"user","content":"hi"}]}`)
	out := stripUnsupportedFieldsForModel(body, "claude-sonnet-4-6")
	if string(out) != string(body) {
		t.Fatalf("sonnet body should be untouched, got: %s", out)
	}
}

func TestIsNativeClaudeModel(t *testing.T) {
	cases := map[string]bool{
		"claude-haiku-4-5":  true,
		"claude-sonnet-4-6": true,
		"claude-opus-4-8":   true,
		"brick-claude":      false,
		"brick":             false,
		"":                  false,
		"gpt-5.5":           false,
	}
	for model, want := range cases {
		if got := isNativeClaudeModel(model); got != want {
			t.Errorf("isNativeClaudeModel(%q) = %v, want %v", model, got, want)
		}
	}
}
