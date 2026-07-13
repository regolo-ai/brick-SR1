package proxy

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/regolo-ai/brick-SR1/apps/router/src/spatial-router/pkg/config"
)

// readRoutingEvents parses a routing_events.jsonl file into records, failing the
// test on any malformed line.
func readRoutingEvents(t *testing.T, path string) []routingEvent {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read routing events: %v", err)
	}
	var out []routingEvent
	for _, line := range strings.Split(strings.TrimSpace(string(raw)), "\n") {
		if line == "" {
			continue
		}
		var ev routingEvent
		if err := json.Unmarshal([]byte(line), &ev); err != nil {
			t.Fatalf("malformed routing event line %q: %v", line, err)
		}
		out = append(out, ev)
	}
	return out
}

// TestRoutingEventLoggerAppend checks the append-only sink round-trips records
// and that a nil logger is a safe no-op (the disabled-log case).
func TestRoutingEventLoggerAppend(t *testing.T) {
	path := filepath.Join(t.TempDir(), "routing_events.jsonl")
	l := newRoutingEventLogger(path)
	if l == nil {
		t.Fatal("logger should open a writable temp path")
	}
	l.append(routingEvent{Mode: "sticky", SessionKey: "k1", CandidateModel: "claude-haiku-4-5", ServedModel: "claude-opus-4-8", CtxTokens: 40000, EstSwitchDelta: 1.23, E2ELatencyMs: 12})
	l.append(routingEvent{Mode: "off", SessionKey: "k2", CandidateModel: "claude-haiku-4-5", ServedModel: "claude-haiku-4-5"})

	var nilLogger *routingEventLogger
	nilLogger.append(routingEvent{Mode: "off"}) // must not panic

	evs := readRoutingEvents(t, path)
	if len(evs) != 2 {
		t.Fatalf("got %d events, want 2", len(evs))
	}
	if evs[0].Mode != "sticky" || evs[0].ServedModel != "claude-opus-4-8" || evs[0].CtxTokens != 40000 || evs[0].EstSwitchDelta != 1.23 {
		t.Fatalf("event 0 round-trip mismatch: %+v", evs[0])
	}
	// A held turn is identifiable purely from the record: candidate != served.
	if evs[0].CandidateModel == evs[0].ServedModel {
		t.Fatalf("event 0 should show a held turn (candidate != served): %+v", evs[0])
	}
	if evs[1].Mode != "off" || evs[1].CandidateModel != evs[1].ServedModel {
		t.Fatalf("event 1 should be an unheld off-mode turn: %+v", evs[1])
	}
}

// TestForwardEmitsRoutingEvent drives forwardAnthropicRequest with a non-nil
// event and a fake Anthropic upstream, asserting exactly one well-formed JSONL
// record is written with the served model, the cached-prefix context size
// (parsed from streamed usage), and a non-negative end-to-end latency.
func TestForwardEmitsRoutingEvent(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		fmt.Fprint(w, fakeAnthropicSSE())
	}))
	defer upstream.Close()

	s := stickyTestServer(t)
	path := filepath.Join(t.TempDir(), "routing_events.jsonl")
	s.routingEventLog = newRoutingEventLogger(path)

	apCfg := &config.AnthropicPassthroughConfig{Enabled: true, UpstreamURL: upstream.URL, RoutingMode: config.RoutingModeOff}
	ev := &routingEvent{Mode: config.RoutingModeOff, SessionKey: anthropicSessionKey([]byte(stickyBody)), CandidateModel: "claude-haiku-4-5"}

	req := httptest.NewRequest(http.MethodPost, "/v1/messages", bytes.NewReader([]byte(stickyBody)))
	rec := httptest.NewRecorder()
	s.forwardAnthropicRequest(rec, req, apCfg, []byte(stickyBody), "claude-haiku-4-5", "easy", "", true, false, "", false, ev)

	if rec.Code != http.StatusOK {
		t.Fatalf("forward status = %d, want 200", rec.Code)
	}
	evs := readRoutingEvents(t, path)
	if len(evs) != 1 {
		t.Fatalf("got %d events, want 1", len(evs))
	}
	got := evs[0]
	if got.ServedModel != "claude-haiku-4-5" {
		t.Fatalf("served_model = %q, want claude-haiku-4-5", got.ServedModel)
	}
	if got.CtxTokens != 40000 { // 1000 input + 39000 cache_read + 0 cache_creation
		t.Fatalf("ctx_tokens = %d, want 40000", got.CtxTokens)
	}
	// Per-turn token breakdown (fakeAnthropicSSE: 1000 fresh, 39000 cache-read, 0
	// cache-write, 200 output) must be broken out for the counterfactual replay.
	if got.FreshInputTokens != 1000 || got.CacheReadTokens != 39000 || got.CacheCreationTokens != 0 || got.OutputTokens != 200 {
		t.Fatalf("token breakdown = fresh %d / read %d / create %d / out %d, want 1000/39000/0/200",
			got.FreshInputTokens, got.CacheReadTokens, got.CacheCreationTokens, got.OutputTokens)
	}
	if got.E2ELatencyMs < 0 {
		t.Fatalf("e2e_latency_ms = %d, want >= 0", got.E2ELatencyMs)
	}
	if got.TS == "" || got.SessionKey == "" {
		t.Fatalf("ts/session_key must be populated: %+v", got)
	}
}
