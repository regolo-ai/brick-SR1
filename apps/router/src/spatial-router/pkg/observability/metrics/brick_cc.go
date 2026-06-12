package metrics

import (
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
)

// Metrics specific to the Brick → Claude Code Anthropic pass-through path.
// They are independent of the OpenAI-style llm_* counters because the
// pass-through bypasses runPipeline entirely; aggregating them under
// llm_model_requests_total would confuse dashboards built against the rest of
// the proxy.

var (
	// BrickCCRequests counts /v1/messages requests forwarded to Anthropic,
	// labelled by classifier verdict and the model the verdict resolved to.
	BrickCCRequests = promauto.NewCounterVec(
		prometheus.CounterOpts{
			Name: "brick_cc_requests_total",
			Help: "Total Anthropic /v1/messages requests routed by Brick, labelled by complexity verdict and selected model.",
		},
		[]string{"label", "model"},
	)

	// BrickCCClassifyDuration measures wall time of a single /classify call.
	BrickCCClassifyDuration = promauto.NewHistogram(
		prometheus.HistogramOpts{
			Name:    "brick_cc_classify_duration_seconds",
			Help:    "Latency of complexity classifier /classify calls (success and timeout both count).",
			Buckets: []float64{0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10},
		},
	)

	// BrickCCClassifyFallback counts requests where the classifier did not
	// return in time and the proxy fell back to "medium". A high rate here
	// means the classifier is too slow for the prompt sizes being sent.
	BrickCCClassifyFallback = promauto.NewCounter(
		prometheus.CounterOpts{
			Name: "brick_cc_classify_fallback_total",
			Help: "Total complexity classifications that fell back to 'medium' due to an upstream error or timeout.",
		},
	)
)
