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
