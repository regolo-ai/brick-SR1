package proxy

import (
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestResponsesToChatMessages_StringInput(t *testing.T) {
	req := &responsesRequest{
		Instructions: "You are terse.",
		Input:        json.RawMessage(`"hello world"`),
	}
	msgs, err := responsesToChatMessages(req)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(msgs) != 2 {
		t.Fatalf("want 2 messages (system+user), got %d: %+v", len(msgs), msgs)
	}
	if msgs[0].Role != "system" || msgs[0].Content != "You are terse." {
		t.Errorf("system message wrong: %+v", msgs[0])
	}
	if msgs[1].Role != "user" || msgs[1].Content != "hello world" {
		t.Errorf("user message wrong: %+v", msgs[1])
	}
}

func TestResponsesToChatMessages_ArrayInputWithParts(t *testing.T) {
	// Codex sends input as an array of items whose content is an array of
	// {type:"input_text", text:...} parts.
	req := &responsesRequest{
		Input: json.RawMessage(`[
			{"type":"message","role":"user","content":[{"type":"input_text","text":"add "},{"type":"input_text","text":"a test"}]}
		]`),
	}
	msgs, err := responsesToChatMessages(req)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(msgs) != 1 {
		t.Fatalf("want 1 message, got %d: %+v", len(msgs), msgs)
	}
	if msgs[0].Role != "user" || msgs[0].Content != "add a test" {
		t.Errorf("flattened content wrong: %+v", msgs[0])
	}
}

func TestResponsesToChatMessages_EmptyInputSkipped(t *testing.T) {
	req := &responsesRequest{
		Input: json.RawMessage(`[{"type":"message","role":"user","content":[]}]`),
	}
	msgs, err := responsesToChatMessages(req)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(msgs) != 0 {
		t.Fatalf("empty-content item should be skipped, got %+v", msgs)
	}
}

func TestExtractChatCompletion(t *testing.T) {
	body := []byte(`{
		"choices":[{"message":{"role":"assistant","content":"42"}}],
		"usage":{"prompt_tokens":10,"completion_tokens":3}
	}`)
	text, usage := extractChatCompletion(body)
	if text != "42" {
		t.Errorf("want text 42, got %q", text)
	}
	if usage.InputTokens != 10 || usage.OutputTokens != 3 || usage.TotalTokens != 13 {
		t.Errorf("usage wrong: %+v", usage)
	}
}

// TestWriteResponsesSSE_EventSequence guards the exact semantic event order
// Codex CLI requires. A missing content_part.added (or any reordering) breaks
// Codex, so this asserts the full sequence and its relative order.
func TestWriteResponsesSSE_EventSequence(t *testing.T) {
	rec := httptest.NewRecorder()
	writeResponsesSSE(rec, "hello", "gpt-5.6-terra", responsesUsage{InputTokens: 5, OutputTokens: 1, TotalTokens: 6})

	got := rec.Body.String()
	want := []string{
		"response.created",
		"response.in_progress",
		"response.output_item.added",
		"response.content_part.added",
		"response.output_text.delta",
		"response.output_text.done",
		"response.content_part.done",
		"response.output_item.done",
		"response.completed",
	}
	lastIdx := -1
	for _, ev := range want {
		idx := strings.Index(got, "event: "+ev+"\n")
		if idx == -1 {
			t.Errorf("missing SSE event %q in stream:\n%s", ev, got)
			continue
		}
		if idx <= lastIdx {
			t.Errorf("SSE event %q out of order (idx %d <= prev %d)", ev, idx, lastIdx)
		}
		lastIdx = idx
	}

	// The delta must carry the full assistant text.
	if !strings.Contains(got, `"delta":"hello"`) {
		t.Errorf("output_text.delta did not carry the text:\n%s", got)
	}
	if ct := rec.Header().Get("Content-Type"); ct != "text/event-stream" {
		t.Errorf("want SSE content-type, got %q", ct)
	}
}

func TestWriteResponsesSSE_EmptyTextSkipsDelta(t *testing.T) {
	rec := httptest.NewRecorder()
	writeResponsesSSE(rec, "", "brick", responsesUsage{})
	if strings.Contains(rec.Body.String(), "response.output_text.delta") {
		t.Errorf("empty text must not emit an output_text.delta event")
	}
	// But completed must still be present so Codex sees a terminal event.
	if !strings.Contains(rec.Body.String(), "event: response.completed\n") {
		t.Errorf("missing terminal response.completed event")
	}
}

func TestWriteResponsesJSON_Shape(t *testing.T) {
	rec := httptest.NewRecorder()
	writeResponsesJSON(rec, "answer", "gpt-5.6-sol", responsesUsage{InputTokens: 2, OutputTokens: 1, TotalTokens: 3})
	var obj struct {
		Object string `json:"object"`
		Status string `json:"status"`
		Model  string `json:"model"`
		Output []struct {
			Type    string `json:"type"`
			Content []struct {
				Type string `json:"type"`
				Text string `json:"text"`
			} `json:"content"`
		} `json:"output"`
		Usage responsesUsage `json:"usage"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &obj); err != nil {
		t.Fatalf("response is not valid JSON: %v", err)
	}
	if obj.Object != "response" || obj.Status != "completed" || obj.Model != "gpt-5.6-sol" {
		t.Errorf("envelope wrong: %+v", obj)
	}
	if len(obj.Output) != 1 || len(obj.Output[0].Content) != 1 || obj.Output[0].Content[0].Text != "answer" {
		t.Errorf("output text wrong: %+v", obj.Output)
	}
	if obj.Usage.TotalTokens != 3 {
		t.Errorf("usage wrong: %+v", obj.Usage)
	}
}
