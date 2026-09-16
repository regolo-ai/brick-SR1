package proxy

import (
	"encoding/json"
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
		{CallID: "brick-a", StartedAt: now, FinishedAt: now, Model: "one", ReasoningMode: "low", RoutingMode: "off", RoutingSource: "routed", Status: "completed", InputTokens: &a, OutputTokens: &b},
		{CallID: "brick-b", StartedAt: now.Add(time.Hour), FinishedAt: now.Add(time.Hour), Model: "two", ReasoningMode: "high", RoutingMode: "sticky", RoutingSource: "native", Status: "failed"},
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
	difficulty, confidence, routing, provider, overall := "hard", .91, int64(12), int64(40), int64(55)
	fallback := false
	if err := h.append(callRecord{CallID: "brick-observed", StartedAt: now, FinishedAt: now, Model: "model-a", ReasoningMode: "high", RoutingMode: "off", RoutingSource: "routed", Status: "completed", Difficulty: &difficulty, DifficultyConfidence: &confidence, RoutingParameters: &routingParameters{CategoryProbabilities: map[string]float64{"code": .8}, CandidateScores: []candidateScore{{Model: "model-a", ExpectedSuccess: .9}}, SelectedProbability: ptrFloat(.9)}, RoutingLatencyMS: &routing, ProviderLatencyMS: &provider, OverallLatencyMS: &overall, ClassifierFallback: &fallback}); err != nil {
		t.Fatal(err)
	}
	s := &Server{callHistory: h}
	rec := httptest.NewRecorder()
	s.handleStats(rec, httptest.NewRequest(http.MethodGet, "/api/v1/stats", nil))
	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body["difficulty"].([]any)[0].(map[string]any)["mode"] != "hard" {
		t.Fatalf("difficulty missing: %s", rec.Body.String())
	}
	if body["latencies"].(map[string]any)["routing"].(map[string]any)["p95_ms"] != float64(12) {
		t.Fatalf("latency missing: %s", rec.Body.String())
	}
	rec = httptest.NewRecorder()
	s.handleStats(rec, httptest.NewRequest(http.MethodGet, "/api/v1/stats/brick-observed", nil))
	if !jsonContains(rec.Body.Bytes(), "category_probabilities") {
		t.Fatalf("detail lost observation: %s", rec.Body.String())
	}
}

func ptrFloat(v float64) *float64 { return &v }
func jsonContains(b []byte, key string) bool {
	var x map[string]any
	return json.Unmarshal(b, &x) == nil && x["routing_parameters"] != nil && x["routing_parameters"].(map[string]any)[key] != nil
}
