package proxy

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/regolo-ai/brick-SR1/apps/router/src/spatial-router/pkg/economics"
)

// TestInjectStreamUsageOption covers the request-body mutation that is the
// one explicitly authorized change to client-facing/upstream traffic: adding
// stream_options.include_usage to streaming requests so the upstream sends a
// usage-bearing final SSE chunk.
func TestInjectStreamUsageOption(t *testing.T) {
	tests := []struct {
		name string
		in   string
		want func(t *testing.T, out []byte)
	}{
		{
			name: "adds stream_options when absent",
			in:   `{"model":"x","stream":true}`,
			want: func(t *testing.T, out []byte) {
				var raw map[string]interface{}
				if err := json.Unmarshal(out, &raw); err != nil {
					t.Fatalf("output not valid JSON: %v", err)
				}
				so, ok := raw["stream_options"].(map[string]interface{})
				if !ok {
					t.Fatalf("expected stream_options object, got %#v", raw["stream_options"])
				}
				if so["include_usage"] != true {
					t.Errorf("expected include_usage=true, got %#v", so["include_usage"])
				}
			},
		},
		{
			name: "does not override existing stream_options",
			in:   `{"model":"x","stream":true,"stream_options":{"include_usage":false}}`,
			want: func(t *testing.T, out []byte) {
				var raw map[string]interface{}
				if err := json.Unmarshal(out, &raw); err != nil {
					t.Fatalf("output not valid JSON: %v", err)
				}
				so, ok := raw["stream_options"].(map[string]interface{})
				if !ok {
					t.Fatalf("expected stream_options object, got %#v", raw["stream_options"])
				}
				if so["include_usage"] != false {
					t.Errorf("existing stream_options was overridden: %#v", so)
				}
			},
		},
		{
			name: "returns invalid JSON unchanged",
			in:   `not json {{{`,
			want: func(t *testing.T, out []byte) {
				if string(out) != `not json {{{` {
					t.Errorf("expected unchanged body, got %q", out)
				}
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			out := injectStreamUsageOption([]byte(tt.in))
			tt.want(t, out)
		})
	}
}

// TestForwardToBackend_RecordsNonStreamingUsage verifies that a non-streaming
// upstream JSON response carrying a "usage" object is recorded into the
// economics store, keyed by RoutingResult.Model.
func TestForwardToBackend_RecordsNonStreamingUsage(t *testing.T) {
	fake := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"id":"chatcmpl-1","model":"backend-model","choices":[{"index":0,"message":{"role":"assistant","content":"hi"}}],"usage":{"prompt_tokens":12,"completion_tokens":7,"total_tokens":19}}`))
	}))
	defer fake.Close()

	store := economics.NewStore()
	srv := &Server{economicsStore: store}

	result := &RoutingResult{
		ForwardBody:     []byte(`{"model":"test-model","messages":[{"role":"user","content":"hi"}]}`),
		ForwardEndpoint: fake.URL,
		ForwardPath:     "/v1/chat/completions",
		ForwardHeaders:  map[string]string{"Authorization": "Bearer test"},
		IsStreaming:     false,
		Model:           "test-model",
	}

	req := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", strings.NewReader(string(result.ForwardBody)))
	w := httptest.NewRecorder()

	srv.forwardToBackend(w, req, result)

	resp := w.Result()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200, got %d", resp.StatusCode)
	}
	// Client-facing body must be forwarded byte-for-byte (no mutation for
	// usage parsing purposes).
	respBody, _ := io.ReadAll(resp.Body)
	if !strings.Contains(string(respBody), `"prompt_tokens":12`) {
		t.Errorf("client response body was altered, got: %s", respBody)
	}

	snap := store.Snapshot()
	if len(snap) != 1 {
		t.Fatalf("expected 1 usage entry, got %d: %+v", len(snap), snap)
	}
	if snap[0].Model != "test-model" || snap[0].InputTokens != 12 || snap[0].OutputTokens != 7 {
		t.Errorf("unexpected usage entry: %+v", snap[0])
	}
}

// TestForwardToBackend_RecordsStreamingUsage verifies that a streaming SSE
// response is scanned for a usage-bearing chunk and that stream_options is
// injected into the outbound request so upstream actually sends usage data.
func TestForwardToBackend_RecordsStreamingUsage(t *testing.T) {
	fake := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		if !strings.Contains(string(body), `"include_usage":true`) {
			t.Errorf("expected stream_options.include_usage injected into upstream request, got: %s", body)
		}
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		flusher, ok := w.(http.Flusher)
		if !ok {
			t.Fatalf("fake server ResponseWriter does not support Flusher")
		}
		chunks := []string{
			`data: {"id":"1","choices":[{"delta":{"content":"Hel"}}]}`,
			`data: {"id":"1","choices":[{"delta":{"content":"lo"}}]}`,
			`data: {"id":"1","choices":[],"usage":{"prompt_tokens":20,"completion_tokens":9,"total_tokens":29}}`,
			`data: [DONE]`,
		}
		for _, c := range chunks {
			fmt.Fprintf(w, "%s\n\n", c)
			flusher.Flush()
		}
	}))
	defer fake.Close()

	store := economics.NewStore()
	srv := &Server{economicsStore: store}

	result := &RoutingResult{
		ForwardBody:     []byte(`{"model":"stream-model","stream":true,"messages":[{"role":"user","content":"hi"}]}`),
		ForwardEndpoint: fake.URL,
		ForwardPath:     "/v1/chat/completions",
		ForwardHeaders:  map[string]string{"Authorization": "Bearer test"},
		IsStreaming:     true,
		Model:           "stream-model",
	}

	req := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", strings.NewReader(string(result.ForwardBody)))
	w := httptest.NewRecorder()

	srv.forwardToBackend(w, req, result)

	body := w.Body.String()
	if !strings.Contains(body, `"prompt_tokens":20`) {
		t.Errorf("client-facing SSE stream was altered/dropped usage chunk, got: %s", body)
	}
	if !strings.Contains(body, "data: [DONE]") {
		t.Errorf("client-facing SSE stream missing terminal [DONE], got: %s", body)
	}

	snap := store.Snapshot()
	if len(snap) != 1 {
		t.Fatalf("expected 1 usage entry, got %d: %+v", len(snap), snap)
	}
	if snap[0].Model != "stream-model" || snap[0].InputTokens != 20 || snap[0].OutputTokens != 9 {
		t.Errorf("unexpected usage entry: %+v", snap[0])
	}
}

// TestForwardToBackend_NoUsageNoRecord verifies that an upstream error body
// without a "usage" field does not panic and does not record spurious usage.
func TestForwardToBackend_NoUsageNoRecord(t *testing.T) {
	fake := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = w.Write([]byte(`{"error":{"message":"boom","type":"server_error","code":500}}`))
	}))
	defer fake.Close()

	store := economics.NewStore()
	srv := &Server{economicsStore: store}

	result := &RoutingResult{
		ForwardBody:     []byte(`{"model":"test-model"}`),
		ForwardEndpoint: fake.URL,
		ForwardPath:     "/v1/chat/completions",
		IsStreaming:     false,
		Model:           "test-model",
	}

	req := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", strings.NewReader(string(result.ForwardBody)))
	w := httptest.NewRecorder()

	srv.forwardToBackend(w, req, result) // must not panic

	if snap := store.Snapshot(); len(snap) != 0 {
		t.Errorf("expected no usage recorded, got %+v", snap)
	}
}

// TestForwardToBackend_EmptyModelSkipsRecord verifies RecordUsage is never
// called with an empty model name, even if the upstream body has usage.
func TestForwardToBackend_EmptyModelSkipsRecord(t *testing.T) {
	fake := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"usage":{"prompt_tokens":5,"completion_tokens":2}}`))
	}))
	defer fake.Close()

	store := economics.NewStore()
	srv := &Server{economicsStore: store}

	result := &RoutingResult{
		ForwardBody:     []byte(`{}`),
		ForwardEndpoint: fake.URL,
		ForwardPath:     "/v1/chat/completions",
		IsStreaming:     false,
		Model:           "", // no model selected
	}

	req := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", strings.NewReader("{}"))
	w := httptest.NewRecorder()

	srv.forwardToBackend(w, req, result)

	if snap := store.Snapshot(); len(snap) != 0 {
		t.Errorf("expected no usage recorded when Model is empty, got %+v", snap)
	}
}

// TestForwardToBackend_NilEconomicsStoreDoesNotPanic guards against a
// regression: several existing tests in this package construct &Server{}
// directly (bypassing NewServer), leaving economicsStore nil. Usage parsing
// must never panic in that case.
func TestForwardToBackend_NilEconomicsStoreDoesNotPanic(t *testing.T) {
	fake := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"usage":{"prompt_tokens":5,"completion_tokens":2}}`))
	}))
	defer fake.Close()

	srv := &Server{} // economicsStore intentionally nil

	result := &RoutingResult{
		ForwardBody:     []byte(`{}`),
		ForwardEndpoint: fake.URL,
		ForwardPath:     "/v1/chat/completions",
		IsStreaming:     false,
		Model:           "test-model",
	}

	req := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", strings.NewReader("{}"))
	w := httptest.NewRecorder()

	srv.forwardToBackend(w, req, result) // must not panic
}
