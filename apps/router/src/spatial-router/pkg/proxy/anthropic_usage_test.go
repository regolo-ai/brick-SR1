package proxy

import (
	"bytes"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/regolo-ai/brick-SR1/apps/router/src/spatial-router/pkg/config"
	"github.com/regolo-ai/brick-SR1/apps/router/src/spatial-router/pkg/economics"
)

// TestAccumulateAnthropicSSEUsage_ChunkedAcrossLines verifies that a realistic
// Anthropic SSE stream, split into small chunks that cut lines mid-way (the
// worst case for a rolling line buffer), still yields the correct
// input/output token counts.
func TestAccumulateAnthropicSSEUsage_ChunkedAcrossLines(t *testing.T) {
	full := "event: message_start\n" +
		`data: {"type":"message_start","message":{"id":"msg_1","usage":{"input_tokens":25,"output_tokens":1}}}` + "\n\n" +
		"event: content_block_delta\n" +
		`data: {"type":"content_block_delta","delta":{"text":"Hel"}}` + "\n\n" +
		"event: message_delta\n" +
		`data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":14}}` + "\n\n" +
		"event: message_stop\n" +
		`data: {"type":"message_stop"}` + "\n\n"

	var chunks [][]byte
	for i := 0; i < len(full); {
		size := 7
		if i+size > len(full) {
			size = len(full) - i
		}
		chunks = append(chunks, []byte(full[i:i+size]))
		i += size
	}

	var buf bytes.Buffer
	var usage anthropicUsage
	for _, c := range chunks {
		accumulateAnthropicSSEUsage(&buf, c, 4*1024*1024, &usage)
	}

	if usage.InputTokens != 25 || usage.OutputTokens != 14 {
		t.Errorf("expected input=25 output=14, got input=%d output=%d", usage.InputTokens, usage.OutputTokens)
	}
}

// TestAccumulateAnthropicSSEUsage_SingleChunk verifies the same stream fed as
// one unsplit chunk produces identical results to the split case.
func TestAccumulateAnthropicSSEUsage_SingleChunk(t *testing.T) {
	full := `data: {"type":"message_start","message":{"usage":{"input_tokens":25,"output_tokens":1}}}` + "\n\n" +
		`data: {"type":"message_delta","usage":{"output_tokens":14}}` + "\n\n"

	var buf bytes.Buffer
	var usage anthropicUsage
	accumulateAnthropicSSEUsage(&buf, []byte(full), 4*1024*1024, &usage)

	if usage.InputTokens != 25 || usage.OutputTokens != 14 {
		t.Errorf("expected input=25 output=14, got input=%d output=%d", usage.InputTokens, usage.OutputTokens)
	}
}

// TestAccumulateAnthropicSSEUsage_MalformedDoesNotPanic verifies that
// non-JSON or unrelated "data:" lines are ignored without panicking and
// without producing spurious usage.
func TestAccumulateAnthropicSSEUsage_MalformedDoesNotPanic(t *testing.T) {
	var buf bytes.Buffer
	var usage anthropicUsage
	accumulateAnthropicSSEUsage(&buf, []byte("data: not json {{{\n"), 4*1024*1024, &usage)

	if usage.InputTokens != 0 || usage.OutputTokens != 0 {
		t.Errorf("expected zero usage for malformed input, got input=%d output=%d", usage.InputTokens, usage.OutputTokens)
	}
}

// TestAccumulateAnthropicSSEUsage_BufferCapPreventsUnboundedGrowth verifies
// that feeding more than maxBuf bytes without a newline resets the buffer
// instead of growing forever.
func TestAccumulateAnthropicSSEUsage_BufferCapPreventsUnboundedGrowth(t *testing.T) {
	var buf bytes.Buffer
	var usage anthropicUsage
	hugeChunk := bytes.Repeat([]byte("x"), 100)
	accumulateAnthropicSSEUsage(&buf, hugeChunk, 50, &usage) // maxBuf smaller than chunk

	if buf.Len() != 0 {
		t.Errorf("expected buffer to be reset when exceeding maxBuf, got len=%d", buf.Len())
	}
}

// TestForwardAnthropicRequest_RecordsNonStreamingUsage verifies that a
// non-streaming Anthropic /v1/messages response carrying top-level "usage"
// is recorded into the economics store under the selected model, and that
// the client-facing body is forwarded byte-for-byte.
func TestForwardAnthropicRequest_RecordsNonStreamingUsage(t *testing.T) {
	fake := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"id":"msg_1","type":"message","role":"assistant","content":[{"type":"text","text":"hi"}],"usage":{"input_tokens":30,"output_tokens":8}}`))
	}))
	defer fake.Close()

	store := economics.NewStore()
	srv := &Server{economicsStore: store}
	apCfg := testAnthropicPassthroughConfig(fake.URL)

	req := httptest.NewRequest(http.MethodPost, "/v1/messages", strings.NewReader(`{"model":"claude-haiku-4-5"}`))
	w := httptest.NewRecorder()

	srv.forwardAnthropicRequest(w, req, apCfg, []byte(`{"model":"claude-haiku-4-5"}`), "claude-haiku-4-5", "easy", "", false, false)

	resp := w.Result()
	body, _ := io.ReadAll(resp.Body)
	if !strings.Contains(string(body), `"input_tokens":30`) {
		t.Errorf("client response body was altered, got: %s", body)
	}

	snap := store.Snapshot()
	if len(snap) != 1 {
		t.Fatalf("expected 1 usage entry, got %d: %+v", len(snap), snap)
	}
	if snap[0].Model != "claude-haiku-4-5" || snap[0].InputTokens != 30 || snap[0].OutputTokens != 8 {
		t.Errorf("unexpected usage entry: %+v", snap[0])
	}
}

// TestForwardAnthropicRequest_RecordsStreamingUsage verifies that a streaming
// SSE Anthropic response is scanned for usage across message_start and
// message_delta events, and that the client-facing SSE stream is forwarded
// unchanged (byte-for-byte, including chunk boundaries irrelevant — content
// only).
func TestForwardAnthropicRequest_RecordsStreamingUsage(t *testing.T) {
	fake := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		flusher, ok := w.(http.Flusher)
		if !ok {
			t.Fatalf("fake server ResponseWriter does not support Flusher")
		}
		events := []string{
			`data: {"type":"message_start","message":{"usage":{"input_tokens":40,"output_tokens":1}}}`,
			`data: {"type":"content_block_delta","delta":{"text":"Hi"}}`,
			`data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":17}}`,
			`data: {"type":"message_stop"}`,
		}
		for _, e := range events {
			fmt.Fprintf(w, "%s\n\n", e)
			flusher.Flush()
		}
	}))
	defer fake.Close()

	store := economics.NewStore()
	srv := &Server{economicsStore: store}
	apCfg := testAnthropicPassthroughConfig(fake.URL)

	req := httptest.NewRequest(http.MethodPost, "/v1/messages", strings.NewReader(`{"model":"claude-sonnet-4-6","stream":true}`))
	w := httptest.NewRecorder()

	srv.forwardAnthropicRequest(w, req, apCfg, []byte(`{"model":"claude-sonnet-4-6","stream":true}`), "claude-sonnet-4-6", "medium", "", false, false)

	body := w.Body.String()
	if !strings.Contains(body, `"input_tokens":40`) {
		t.Errorf("client-facing SSE stream was altered/dropped usage chunk, got: %s", body)
	}
	if !strings.Contains(body, `"type":"message_stop"`) {
		t.Errorf("client-facing SSE stream missing terminal event, got: %s", body)
	}

	snap := store.Snapshot()
	if len(snap) != 1 {
		t.Fatalf("expected 1 usage entry, got %d: %+v", len(snap), snap)
	}
	if snap[0].Model != "claude-sonnet-4-6" || snap[0].InputTokens != 40 || snap[0].OutputTokens != 17 {
		t.Errorf("unexpected usage entry: %+v", snap[0])
	}
}

// TestForwardAnthropicRequest_NoUsageNoRecord verifies that an upstream error
// body without a "usage" field does not panic and does not record spurious
// usage.
func TestForwardAnthropicRequest_NoUsageNoRecord(t *testing.T) {
	fake := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadRequest)
		_, _ = w.Write([]byte(`{"type":"error","error":{"type":"invalid_request_error","message":"boom"}}`))
	}))
	defer fake.Close()

	store := economics.NewStore()
	srv := &Server{economicsStore: store}
	apCfg := testAnthropicPassthroughConfig(fake.URL)

	req := httptest.NewRequest(http.MethodPost, "/v1/messages", strings.NewReader(`{}`))
	w := httptest.NewRecorder()

	srv.forwardAnthropicRequest(w, req, apCfg, []byte(`{}`), "claude-haiku-4-5", "easy", "", false, false) // must not panic

	if snap := store.Snapshot(); len(snap) != 0 {
		t.Errorf("expected no usage recorded, got %+v", snap)
	}
}

// TestForwardAnthropicRequest_NilEconomicsStoreDoesNotPanic guards against a
// regression: constructing &Server{} directly (as many existing tests in
// this package do) leaves economicsStore nil. Usage parsing must never
// panic in that case.
func TestForwardAnthropicRequest_NilEconomicsStoreDoesNotPanic(t *testing.T) {
	fake := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"usage":{"input_tokens":5,"output_tokens":2}}`))
	}))
	defer fake.Close()

	srv := &Server{} // economicsStore intentionally nil
	apCfg := testAnthropicPassthroughConfig(fake.URL)

	req := httptest.NewRequest(http.MethodPost, "/v1/messages", strings.NewReader(`{}`))
	w := httptest.NewRecorder()

	srv.forwardAnthropicRequest(w, req, apCfg, []byte(`{}`), "claude-haiku-4-5", "easy", "", false, false) // must not panic
}

// testAnthropicPassthroughConfig builds a minimal, real
// config.AnthropicPassthroughConfig pointing at a test upstream URL, for use
// with forwardAnthropicRequest in these tests.
func testAnthropicPassthroughConfig(upstreamURL string) *config.AnthropicPassthroughConfig {
	return &config.AnthropicPassthroughConfig{UpstreamURL: upstreamURL}
}
