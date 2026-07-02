package proxy

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/prometheus/client_golang/prometheus/testutil"
	"github.com/regolo-ai/brick-SR1/apps/router/src/spatial-router/pkg/observability/metrics"
)

// TestHandleMetricsReset verifies the reset endpoint: GET is rejected, POST
// clears the brick_cc_* counters and returns 200.
func TestHandleMetricsReset(t *testing.T) {
	srv := &Server{}

	// GET is not allowed.
	rec := httptest.NewRecorder()
	srv.handleMetricsReset(rec, httptest.NewRequest(http.MethodGet, "/api/v1/metrics/reset", nil))
	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("GET should be 405, got %d", rec.Code)
	}

	// Seed a counter, then POST to clear it.
	metrics.BrickCCRequests.WithLabelValues("hard", "claude-opus-4-8").Inc()
	if testutil.CollectAndCount(metrics.BrickCCRequests) == 0 {
		t.Fatalf("expected a seeded series before reset")
	}

	rec = httptest.NewRecorder()
	srv.handleMetricsReset(rec, httptest.NewRequest(http.MethodPost, "/api/v1/metrics/reset", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("POST should be 200, got %d", rec.Code)
	}
	if got := testutil.CollectAndCount(metrics.BrickCCRequests); got != 0 {
		t.Fatalf("reset did not clear BrickCCRequests: %d series remain", got)
	}
}
