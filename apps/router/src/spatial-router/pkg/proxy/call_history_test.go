package proxy

import (
	"encoding/json"
	"github.com/regolo-ai/brick-SR1/apps/router/src/spatial-router/pkg/brickrouting"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"
)

func TestCallHistoryStatsFiltersPaginationAndClear(t *testing.T) {
	d := t.TempDir()
	h := newCallHistory(filepath.Join(d, "calls.jsonl"))
	now := time.Date(2026, 3, 29, 10, 0, 0, 0, time.UTC)
	a, b := int64(10), int64(4)
	for _, r := range []callRecord{
		{CallID: "brick-a", StartedAt: now, FinishedAt: now, Model: "one", ReasoningMode: "low", RoutingSource: "routed", Status: "completed", InputTokens: &a, OutputTokens: &b},
		{CallID: "brick-b", StartedAt: now.Add(time.Hour), FinishedAt: now.Add(time.Hour), Model: "two", ReasoningMode: "high", RoutingSource: "native", Status: "failed"},
	} {
		if err := h.append(r); err != nil {
			t.Fatal(err)
		}
	}
	s := &Server{callHistory: h}
	rec := httptest.NewRecorder()
	s.handleStats(rec, httptest.NewRequest(http.MethodGet, "/api/v1/stats?model=one", nil))
	if rec.Code != 200 {
		t.Fatalf("stats=%d: %s", rec.Code, rec.Body.String())
	}
	if rec.Body.String() == "" {
		t.Fatal("empty stats response")
	}
	rec = httptest.NewRecorder()
	s.handleStats(rec, httptest.NewRequest(http.MethodGet, "/api/v1/stats/all?limit=1", nil))
	if rec.Code != 200 {
		t.Fatalf("all=%d", rec.Code)
	}
	rec = httptest.NewRecorder()
	s.handleStats(rec, httptest.NewRequest(http.MethodPost, "/api/v1/stats/clear", nil))
	if rec.Code != 200 {
		t.Fatalf("clear=%d", rec.Code)
	}
	got, err := h.records()
	if err != nil || len(got) != 0 {
		t.Fatalf("remaining=%d err=%v", len(got), err)
	}
}

func TestCallHistoryStatsIncludesRoutingObservationAndLatency(t *testing.T) {
	d := t.TempDir()
	h := newCallHistory(filepath.Join(d, "calls.jsonl"))
	now := time.Date(2026, 3, 29, 10, 0, 0, 0, time.UTC)
	routing, provider, overall := int64(12), int64(40), int64(55)
	if err := h.append(callRecord{CallID: "brick-observed", StartedAt: now, FinishedAt: now, Model: "model-a", ReasoningMode: "high", RoutingSource: "routed", Status: "completed", RoutingParameters: &brickrouting.Result{Model: "model-a", QueryVector: []float64{.8, .2, 0, 0, 0, 0}, ScaledVector: []float64{1, .3, 0, 0, 0, 0}, Knob: 1, Distances: []brickrouting.ModelDistance{{Model: "model-a", Distance: .4}}}, RoutingLatencyMS: &routing, ProviderLatencyMS: &provider, OverallLatencyMS: &overall}); err != nil {
		t.Fatal(err)
	}
	s := &Server{callHistory: h}
	rec := httptest.NewRecorder()
	s.handleStats(rec, httptest.NewRequest(http.MethodGet, "/api/v1/stats", nil))
	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body["difficulty"] != nil || body["classifier"] != nil {
		t.Fatalf("obsolete diagnostics remain: %s", rec.Body.String())
	}
	if body["latencies"].(map[string]any)["routing"].(map[string]any)["p95_ms"] != float64(12) {
		t.Fatalf("latency missing: %s", rec.Body.String())
	}
	rec = httptest.NewRecorder()
	s.handleStats(rec, httptest.NewRequest(http.MethodGet, "/api/v1/stats/brick-observed", nil))
	if !jsonContains(rec.Body.Bytes(), "query_vector") {
		t.Fatalf("detail lost observation: %s", rec.Body.String())
	}
}

func jsonContains(b []byte, key string) bool {
	var x map[string]any
	return json.Unmarshal(b, &x) == nil && x["routing_parameters"] != nil && x["routing_parameters"].(map[string]any)[key] != nil
}

func TestResponsesObservationPreservesStreamingAndCountsCachedUsage(t *testing.T) {
	for _, streaming := range []bool{false, true} {
		recorder := httptest.NewRecorder()
		writer := &statusWriter{ResponseWriter: recorder}
		payload := `{"id":"response","usage":{"input_tokens":10,"output_tokens":4,"input_tokens_details":{"cached_tokens":3}}}`
		if streaming {
			writer.Header().Set("Content-Type", "text/event-stream")
			payload = "data: {\"type\":\"response.completed\",\"response\":" + payload + "}\n\ndata: [DONE]\n\n"
		}
		_, _ = writer.Write([]byte(payload[:15]))
		_, _ = writer.Write([]byte(payload[15:]))
		if !streaming {
			writer.observeUsage(writer.usageBuffer.Bytes())
		}
		if recorder.Body.String() != payload || writer.inputTokens == nil || *writer.inputTokens != 10 || writer.outputTokens == nil || *writer.outputTokens != 4 || writer.cachedTokens != 3 {
			t.Fatal("usage observation changed streaming or lost accounting", recorder.Body.String(), writer)
		}
	}
}
