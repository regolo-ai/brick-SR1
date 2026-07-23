package proxy

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"github.com/regolo-ai/brick-SR1/apps/router/src/spatial-router/pkg/config"
)

// TestForwardCapturesRateLimitHeadersAndTag drives forwardAnthropicRequest
// against a fake Anthropic upstream that emits plan rate-limit headers,
// asserting the routing event captures them (prefix stripped, lowercase keys),
// records the upstream status and the harness attribution tag, and that the
// x-brick-ab-tag header is never forwarded upstream.
func TestForwardCapturesRateLimitHeadersAndTag(t *testing.T) {
	var upstreamSawTag bool
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("x-brick-ab-tag") != "" {
			upstreamSawTag = true
		}
		w.Header().Set("Anthropic-Ratelimit-Unified-5h-Utilization", "12")
		w.Header().Set("Anthropic-Ratelimit-Unified-Status", "allowed")
		w.Header().Set("Anthropic-Ratelimit-Unified-Reset", "2026-07-23T18:00:00Z")
		w.Header().Set("X-Unrelated", "keep-out")
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		fmt.Fprint(w, fakeAnthropicSSE())
	}))
	defer upstream.Close()

	s := stickyTestServer(t)
	path := filepath.Join(t.TempDir(), "routing_events.jsonl")
	s.routingEventLog = newRoutingEventLogger(path)

	apCfg := &config.AnthropicPassthroughConfig{Enabled: true, UpstreamURL: upstream.URL, RoutingMode: config.RoutingModeOff}
	ev := &routingEvent{Mode: config.RoutingModeOff, CandidateModel: "claude-haiku-4-5"}

	const tag = "run1|brick_on|qa_01|rep1"
	req := httptest.NewRequest(http.MethodPost, "/v1/messages", bytes.NewReader([]byte(stickyBody)))
	req.Header.Set("x-brick-ab-tag", tag)
	rec := httptest.NewRecorder()
	s.forwardAnthropicRequest(rec, req, apCfg, []byte(stickyBody), "claude-haiku-4-5", "easy", "", true, false, "", false, ev)

	if rec.Code != http.StatusOK {
		t.Fatalf("forward status = %d, want 200", rec.Code)
	}
	if upstreamSawTag {
		t.Fatal("x-brick-ab-tag must be stripped before forwarding upstream")
	}

	evs := readRoutingEvents(t, path)
	if len(evs) != 1 {
		t.Fatalf("got %d events, want 1", len(evs))
	}
	got := evs[0]
	if got.RequestTag != tag {
		t.Fatalf("request_tag = %q, want %q", got.RequestTag, tag)
	}
	if got.UpstreamStatus != http.StatusOK {
		t.Fatalf("upstream_status = %d, want 200", got.UpstreamStatus)
	}
	want := map[string]string{
		"unified-5h-utilization": "12",
		"unified-status":         "allowed",
		"unified-reset":          "2026-07-23T18:00:00Z",
	}
	if len(got.RateLimitHeaders) != len(want) {
		t.Fatalf("ratelimit_headers = %v, want exactly %v", got.RateLimitHeaders, want)
	}
	for k, v := range want {
		if got.RateLimitHeaders[k] != v {
			t.Fatalf("ratelimit_headers[%q] = %q, want %q", k, got.RateLimitHeaders[k], v)
		}
	}
}

// TestNativePassthroughEmitsRoutingEvent exercises handleNativeModel end to
// end: the explicit-model path must now emit a routing event with the
// passthrough_native mode, the requested model as served model, the streamed
// token breakdown, and the captured rate-limit headers, so the plan-savings
// A/B suite can measure the Brick OFF branch identically to the ON branch.
func TestNativePassthroughEmitsRoutingEvent(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Anthropic-Ratelimit-Unified-Weekly-Utilization", "37")
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		fmt.Fprint(w, fakeAnthropicSSE())
	}))
	defer upstream.Close()

	s := stickyTestServer(t)
	path := filepath.Join(t.TempDir(), "routing_events.jsonl")
	s.routingEventLog = newRoutingEventLogger(path)

	cfg := &config.RouterConfig{}
	apCfg := &config.AnthropicPassthroughConfig{Enabled: true, UpstreamURL: upstream.URL}

	req := httptest.NewRequest(http.MethodPost, "/v1/messages", bytes.NewReader([]byte(stickyBody)))
	rec := httptest.NewRecorder()
	s.handleNativeModel(rec, req, cfg, apCfg, []byte(stickyBody), "claude-sonnet-4-6")

	if rec.Code != http.StatusOK {
		t.Fatalf("native forward status = %d, want 200", rec.Code)
	}
	evs := readRoutingEvents(t, path)
	if len(evs) != 1 {
		t.Fatalf("got %d events, want 1", len(evs))
	}
	got := evs[0]
	if got.Mode != modePassthroughNative {
		t.Fatalf("mode = %q, want %q", got.Mode, modePassthroughNative)
	}
	if got.ServedModel != "claude-sonnet-4-6" || got.RequestedModel != "claude-sonnet-4-6" || got.CandidateModel != "claude-sonnet-4-6" {
		t.Fatalf("model fields must all equal the requested model: %+v", got)
	}
	if got.FreshInputTokens != 1000 || got.CacheReadTokens != 39000 || got.OutputTokens != 200 {
		t.Fatalf("token breakdown = fresh %d / read %d / out %d, want 1000/39000/200",
			got.FreshInputTokens, got.CacheReadTokens, got.OutputTokens)
	}
	if got.RateLimitHeaders["unified-weekly-utilization"] != "37" {
		t.Fatalf("ratelimit_headers = %v, want unified-weekly-utilization=37", got.RateLimitHeaders)
	}
	if got.SessionKey == "" || got.TS == "" {
		t.Fatalf("session_key/ts must be populated: %+v", got)
	}
	if got.ClassifierPromptChars != 0 {
		t.Fatalf("classifier_prompt_chars = %d, want 0 on the native path", got.ClassifierPromptChars)
	}
}

// TestRoutingEventLegacyRecordRoundTrip guards JSONL backward compatibility:
// a pre-existing record without the new plan-measurement fields must
// deserialize cleanly with zero values, and a record without them set must
// marshal without emitting the new keys (all omitempty).
func TestRoutingEventLegacyRecordRoundTrip(t *testing.T) {
	legacy := `{"ts":"2026-07-01T00:00:00Z","mode":"sticky","candidate_model":"a","served_model":"b","ctx_tokens":10,"est_switch_delta_price_units":0.5,"e2e_latency_ms":3}`
	var ev routingEvent
	if err := json.Unmarshal([]byte(legacy), &ev); err != nil {
		t.Fatalf("legacy record must unmarshal cleanly: %v", err)
	}
	if ev.RateLimitHeaders != nil || ev.RequestTag != "" || ev.UpstreamStatus != 0 || ev.RequestedModel != "" || ev.ClassifierPromptChars != 0 {
		t.Fatalf("legacy record must leave new fields zero: %+v", ev)
	}

	out, err := json.Marshal(routingEvent{Mode: "off", CandidateModel: "a", ServedModel: "a"})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	for _, key := range []string{"ratelimit_headers", "request_tag", "upstream_status", "requested_model", "classifier_prompt_chars"} {
		if bytes.Contains(out, []byte(key)) {
			t.Fatalf("unset new field %q must be omitted from JSON: %s", key, out)
		}
	}
}
