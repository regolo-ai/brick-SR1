package metrics

import (
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
)

// Metrics specific to the Brick Claude/Codex gateway paths. They are independent
// of the OpenAI-style llm_* counters because these gateways bypass runPipeline;
// aggregating them under llm_model_requests_total would confuse dashboards built
// against the rest of the proxy.

var (
	// BrickCCRequests counts Claude /v1/messages and Codex /v1/chat/completions
	// requests, labelled by classifier verdict and the selected model.
	BrickCCRequests = promauto.NewCounterVec(
		prometheus.CounterOpts{
			Name: "brick_cc_requests_total",
			Help: "Total Claude/Codex requests routed by Brick, labelled by complexity verdict and selected model.",
		},
		[]string{"label", "model"},
	)

	// BrickCCEffort counts Brick-routed requests by selected model and the
	// autonomous reasoning effort Brick assigned to them. Only emitted on
	// the skill-routed + dynamic-effort path (native and non-dynamic requests have
	// no Brick-decided effort).
	BrickCCEffort = promauto.NewCounterVec(
		prometheus.CounterOpts{
			Name: "brick_cc_effort_total",
			Help: "Total Brick-routed /v1/messages requests labelled by selected model and autonomous reasoning effort.",
		},
		[]string{"model", "effort"},
	)

	// BrickCCRouting correlates the classifier verdict, the autonomous effort, and
	// the selected model on a single routed request: the cross-product the two
	// marginal counters above cannot reconstruct. Feeds the status heatmap. Like
	// BrickCCEffort it is only emitted on the skill-routed + dynamic-effort path.
	BrickCCRouting = promauto.NewCounterVec(
		prometheus.CounterOpts{
			Name: "brick_cc_routing_total",
			Help: "Brick-routed /v1/messages requests labelled by complexity verdict, autonomous effort, and selected model.",
		},
		[]string{"difficulty", "effort", "model"},
	)

	// BrickCCClassifyDuration measures wall time of a single /classify call.
	// It is a zero-label HistogramVec (not a plain Histogram) so ResetBrickCC can
	// clear it via .Reset(); the exposition is identical to a label-less histogram,
	// so the `brick claude status` parser is unaffected. Observe via
	// WithLabelValues().Observe(...).
	BrickCCClassifyDuration = promauto.NewHistogramVec(
		prometheus.HistogramOpts{
			Name:    "brick_cc_classify_duration_seconds",
			Help:    "Latency of complexity classifier /classify calls (success and timeout both count).",
			Buckets: []float64{0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10},
		},
		[]string{},
	)

	// BrickCCClassifyFallback counts requests where the classifier did not
	// return in time and the proxy fell back to "medium". A high rate here means
	// the classifier is too slow for the prompt sizes being sent.
	// Zero-label CounterVec (see BrickCCClassifyDuration) so it is resettable.
	// Increment via WithLabelValues().Inc().
	BrickCCClassifyFallback = promauto.NewCounterVec(
		prometheus.CounterOpts{
			Name: "brick_cc_classify_fallback_total",
			Help: "Total complexity classifications that fell back to 'medium' due to an upstream error or timeout.",
		},
		[]string{},
	)
)

// ResetBrickCC clears every Brick Claude/Codex gateway counter and histogram so
// status dashboards can start fresh without restarting the router. All five
// metrics are (zero-label) Vec types, so .Reset() drops their series in place.
// Only the Brick gateway metrics are touched; OpenAI-style llm_* counters and
// everything else are left intact.
func ResetBrickCC() {
	BrickCCRequests.Reset()
	BrickCCEffort.Reset()
	BrickCCRouting.Reset()
	BrickCCClassifyDuration.Reset()
	BrickCCClassifyFallback.Reset()
}
