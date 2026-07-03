package metrics

import (
	"strings"
	"testing"

	"github.com/prometheus/client_golang/prometheus/testutil"
)

// TestResetBrickCC verifies that ResetBrickCC clears every Brick pass-through
// counter/histogram back to zero series, so `brick claude status` can show a
// fresh dashboard without a router restart.
func TestResetBrickCC(t *testing.T) {
	// Populate each metric.
	BrickCCRequests.WithLabelValues("hard", "claude-opus-4-8").Inc()
	BrickCCEffort.WithLabelValues("claude-opus-4-8", "high").Inc()
	BrickCCRouting.WithLabelValues("hard", "high", "claude-opus-4-8").Inc()
	BrickCCClassifyDuration.WithLabelValues().Observe(0.3)
	BrickCCClassifyFallback.WithLabelValues().Inc()

	if got := testutil.CollectAndCount(BrickCCRequests); got == 0 {
		t.Fatalf("expected BrickCCRequests to have series before reset")
	}

	ResetBrickCC()

	if got := testutil.CollectAndCount(BrickCCRequests); got != 0 {
		t.Fatalf("BrickCCRequests not cleared: %d series remain", got)
	}
	if got := testutil.CollectAndCount(BrickCCEffort); got != 0 {
		t.Fatalf("BrickCCEffort not cleared: %d series remain", got)
	}
	if got := testutil.CollectAndCount(BrickCCRouting); got != 0 {
		t.Fatalf("BrickCCRouting not cleared: %d series remain", got)
	}
	if got := testutil.CollectAndCount(BrickCCClassifyDuration); got != 0 {
		t.Fatalf("BrickCCClassifyDuration not cleared: %d series remain", got)
	}
	if got := testutil.CollectAndCount(BrickCCClassifyFallback); got != 0 {
		t.Fatalf("BrickCCClassifyFallback not cleared: %d series remain", got)
	}
}

// TestBrickCCFallbackExpositionIsBare guards the contract with the
// `brick claude status` CLI parser: converting the fallback counter to a
// zero-label Vec must NOT add a `{}` label set, or the parser's
// `^brick_cc_classify_fallback_total\s+value$` regex stops matching.
func TestBrickCCFallbackExpositionIsBare(t *testing.T) {
	BrickCCClassifyFallback.Reset()
	BrickCCClassifyFallback.WithLabelValues().Inc()

	// Bare `name value` (no `{}`) is exactly what the CLI regex expects. If the
	// zero-label Vec emitted `brick_cc_classify_fallback_total{} 1`, this fails.
	expected := `# HELP brick_cc_classify_fallback_total Total complexity classifications that fell back to 'medium' due to an upstream error or timeout.
# TYPE brick_cc_classify_fallback_total counter
brick_cc_classify_fallback_total 1
`
	if err := testutil.CollectAndCompare(BrickCCClassifyFallback, strings.NewReader(expected)); err != nil {
		t.Fatalf("fallback exposition drifted from bare `name value`: %v", err)
	}
}
