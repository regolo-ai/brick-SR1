package proxy

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/regolo-ai/brick-SR1/apps/router/src/spatial-router/pkg/config"
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

func TestChatGPTCodexForwardHeaders_PreservesAuthAndCodexMetadata(t *testing.T) {
	src := make(http.Header)
	src.Set("Authorization", "Bearer oauth-token")
	src.Set("ChatGPT-Account-ID", "workspace-123")
	src.Set("Originator", "codex_exec")
	src.Set("X-Codex-Installation-Id", "install-123")
	src.Set("X-Codex-Turn-State", "turn-state")
	src.Set("Connection", "keep-alive")
	src.Set("X-Selected-Model", "internal-only")

	got := chatGPTCodexForwardHeaders(src)
	for key, want := range map[string]string{
		"Authorization":           "Bearer oauth-token",
		"ChatGPT-Account-ID":      "workspace-123",
		"Originator":              "codex_exec",
		"X-Codex-Installation-Id": "install-123",
		"X-Codex-Turn-State":      "turn-state",
	} {
		value := ""
		for gotKey, gotValue := range got {
			if strings.EqualFold(gotKey, key) {
				value = gotValue
				break
			}
		}
		if value != want {
			t.Errorf("header %s = %q, want %q", key, value, want)
		}
	}
	if _, ok := got["Connection"]; ok {
		t.Error("hop-by-hop Connection header must not be forwarded")
	}
	if _, ok := got["X-Selected-Model"]; ok {
		t.Error("internal X-Selected-Model header must not be forwarded")
	}
}

func TestApplyResponsesReasoningLevel_PreservesResponsesPayload(t *testing.T) {
	useReasoning := true
	cfg := &config.RouterConfig{
		SkillRouter: config.SkillRouterConfig{
			Models: []config.SkillRouterModelConfig{{
				Model: "gpt-5.6-terra",
				ModelReasoningControl: config.ModelReasoningControl{
					UseReasoning: &useReasoning,
				},
			}},
		},
	}
	body := []byte(`{
		"model":"brick",
		"input":[{"type":"function_call_output","call_id":"call_1","output":"ok"}],
		"tools":[{"type":"function","name":"shell"}],
		"reasoning":{"effort":"high","summary":"auto"},
		"stream":true
	}`)

	gotBody, effort := applyResponsesReasoningLevel(body, cfg, "gpt-5.6-terra", 2)
	if effort != "medium" {
		t.Fatalf("effort = %q, want medium", effort)
	}
	var got map[string]interface{}
	if err := json.Unmarshal(gotBody, &got); err != nil {
		t.Fatalf("rewritten body is invalid JSON: %v", err)
	}
	if got["reasoning_effort"] != nil || got["thinking"] != nil {
		t.Fatalf("Chat-only reasoning fields leaked into Responses payload: %v", got)
	}
	reasoning, ok := got["reasoning"].(map[string]interface{})
	if !ok || reasoning["effort"] != "medium" || reasoning["summary"] != "auto" {
		t.Fatalf("Responses reasoning object was not preserved/re-written correctly: %v", got["reasoning"])
	}
	if _, ok := got["tools"]; !ok {
		t.Error("tools were dropped from native Responses payload")
	}
	if _, ok := got["input"]; !ok {
		t.Error("function-call input was dropped from native Responses payload")
	}
}

func TestNativeResponsesForward_PreservesBodyHeadersAndSSE(t *testing.T) {
	var gotPath string
	var gotBody []byte
	var gotHeaders http.Header
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotHeaders = r.Header.Clone()
		gotBody, _ = io.ReadAll(r.Body)
		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("X-Codex-Turn-State", "next-turn")
		_, _ = w.Write([]byte("event: response.completed\n" +
			"data: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\",\"usage\":{\"input_tokens\":11,\"output_tokens\":2}}}\n\n"))
	}))
	defer backend.Close()

	srv := &Server{}
	body := []byte(`{"model":"gpt-5.6-terra","input":"hello","tools":[{"type":"function","name":"shell"}],"stream":true}`)
	req := httptest.NewRequest(http.MethodPost, "/v1/responses", strings.NewReader(string(body)))
	result := &RoutingResult{
		ForwardBody:     body,
		ForwardEndpoint: extractHost(backend.URL),
		ForwardPath:     "/backend-api/codex/responses",
		ForwardHeaders: map[string]string{
			"Authorization":      "Bearer oauth-token",
			"ChatGPT-Account-ID": "workspace-123",
		},
		IsStreaming: true,
		IsResponses: true,
		Model:       "gpt-5.6-terra",
	}
	rec := httptest.NewRecorder()
	srv.forwardToBackend(rec, req, result)

	if gotPath != "/backend-api/codex/responses" {
		t.Errorf("upstream path = %q", gotPath)
	}
	if gotHeaders.Get("Authorization") != "Bearer oauth-token" || gotHeaders.Get("ChatGPT-Account-ID") != "workspace-123" {
		t.Fatalf("ChatGPT auth headers missing upstream: %v", gotHeaders)
	}
	if string(gotBody) != string(body) {
		t.Fatalf("native Responses body changed unexpectedly:\ngot  %s\nwant %s", gotBody, body)
	}
	if strings.Contains(string(gotBody), "stream_options") {
		t.Error("Chat Completions stream_options leaked into native Responses request")
	}
	if rec.Header().Get("X-Codex-Turn-State") != "next-turn" {
		t.Errorf("turn-state response header = %q", rec.Header().Get("X-Codex-Turn-State"))
	}
	if !strings.Contains(rec.Body.String(), "event: response.completed") {
		t.Fatalf("SSE stream was not forwarded: %s", rec.Body.String())
	}
}

func TestExtractOpenAIUsage_ResponsesCompletedEvent(t *testing.T) {
	payload := []byte(`{"type":"response.completed","response":{"usage":{"input_tokens":11,"output_tokens":2}}}`)
	got := extractOpenAIUsage(payload)
	if got.PromptTokens != 11 || got.CompletionTokens != 2 {
		t.Fatalf("Responses usage = %+v, want prompt=11 completion=2", got)
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

// TestResponsesEndToEnd_NotFourOhFour is the regression guard for the fatal bug
// this handler fixes: before /v1/responses was registered, wiring Codex with
// wire_api="responses" made every request 404. This drives a Responses request
// through the full stack (handler -> handleBrickRequest -> forwardToBackend) to
// a fake OpenAI backend and asserts a 200 SSE Responses stream comes back with
// the assistant text the backend produced.
func TestResponsesEndToEnd_NotFourOhFour(t *testing.T) {
	// Fake OpenAI backend: returns a non-streaming Chat Completion (the handler
	// always calls upstream non-streaming).
	var gotPath string
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"choices":[{"message":{"role":"assistant","content":"hi from codex"}}],"usage":{"prompt_tokens":7,"completion_tokens":4}}`))
	}))
	defer backend.Close()

	cfg := &config.RouterConfig{
		BrickExtension: config.BrickExtension{
			Brick: config.BrickConfig{Enabled: true},
		},
		BackendModels: config.BackendModels{
			ModelConfig: map[string]config.ModelParams{
				"gpt-5.6-terra": {},
			},
		},
		SkillRouter: config.SkillRouterConfig{
			Enabled: true,
			Models: []config.SkillRouterModelConfig{
				{
					Model:   "gpt-5.6-terra",
					BaseURL: backend.URL + "/v1",
					APIKey:  "sk-test-fake",
				},
			},
		},
	}
	srv := &Server{cfg: cfg}

	// A Codex-shaped Responses request. x-selected-model bypasses the skill
	// router (which would need model weights loaded) and pins the backend.
	body := `{"model":"gpt-5.6-terra","instructions":"be terse","input":"say hi","stream":true}`
	req := httptest.NewRequest(http.MethodPost, "/v1/responses", strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer client-key")
	req.Header.Set("x-selected-model", "gpt-5.6-terra")
	rec := httptest.NewRecorder()

	srv.handleResponses(rec, req)

	resp := rec.Result()
	if resp.StatusCode == http.StatusNotFound {
		t.Fatal("/v1/responses returned 404 — the bug this handler fixes")
	}
	if resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(resp.Body)
		t.Fatalf("status = %d, want 200; body=%s", resp.StatusCode, b)
	}
	if gotPath != "/v1/chat/completions" {
		t.Errorf("backend path = %q, want /v1/chat/completions (handler must translate to Chat)", gotPath)
	}
	out := rec.Body.String()
	if !strings.Contains(out, "event: response.completed\n") {
		t.Errorf("missing terminal response.completed event:\n%s", out)
	}
	if !strings.Contains(out, `"delta":"hi from codex"`) {
		t.Errorf("assistant text not delivered in SSE stream:\n%s", out)
	}
}
