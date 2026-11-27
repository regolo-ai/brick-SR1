package metrics

import (
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
)

var BrickRequests = promauto.NewCounterVec(prometheus.CounterOpts{
	Name: "brick_requests_total", Help: "Brick gateway requests by routing source and selected model.",
}, []string{"source", "model"})

var SystemOneDuration = promauto.NewHistogramVec(prometheus.HistogramOpts{
	Name: "brick_systemone_duration_seconds", Help: "Local SystemOne inference duration.",
	Buckets: []float64{0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10},
}, []string{"outcome"})

var KeywordRoutes = promauto.NewCounterVec(prometheus.CounterOpts{
	Name: "brick_keyword_route_total", Help: "Requests routed by a strict keyword rule.",
}, []string{"rule", "model"})

var KeywordBlocked = promauto.NewCounterVec(prometheus.CounterOpts{
	Name: "brick_keyword_blocked_total", Help: "Strict keyword matches rejected because the model could not serve the request.",
}, []string{"rule", "reason"})

func ResetRouting() {
	BrickRequests.Reset()
	SystemOneDuration.Reset()
	KeywordRoutes.Reset()
	KeywordBlocked.Reset()
}
