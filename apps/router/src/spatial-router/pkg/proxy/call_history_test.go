package proxy

import (
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
