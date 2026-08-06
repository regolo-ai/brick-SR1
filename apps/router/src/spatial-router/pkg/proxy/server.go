package proxy

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"path/filepath"
	"sync"
	"time"

	"github.com/prometheus/client_golang/prometheus/promhttp"
	"github.com/regolo-ai/brick-SR1/apps/router/src/spatial-router/pkg/brickrouting"
	"github.com/regolo-ai/brick-SR1/apps/router/src/spatial-router/pkg/config"
	"github.com/regolo-ai/brick-SR1/apps/router/src/spatial-router/pkg/economics"
	"github.com/regolo-ai/brick-SR1/apps/router/src/spatial-router/pkg/observability/logging"
	"github.com/regolo-ai/brick-SR1/apps/router/src/spatial-router/pkg/observability/metrics"
	"github.com/regolo-ai/brick-SR1/apps/router/src/spatial-router/pkg/sticky"
)

// Server is the Brick HTTP proxy server.
// It exposes OpenAI-compatible endpoints and routes requests through Brick2.
type Server struct {
	cfg        *config.RouterConfig
	configPath string
	port       int
	httpServer *http.Server

	brickRouterOnce sync.Once
	brickRouter     *brickrouting.Router
	brickRouterErr  error

	economicsStore *economics.Store
	// pricingPath is where pricing.yaml lives, used by handleEconomics to
	// load a PricingTable on demand. Derived from configPath's directory so
	// it sits next to the router config by convention.
	pricingPath string
	// economicsSnapshotPath is where the economics.Store's usage counters are
	// periodically persisted, so `brick claude status`'s real-savings figure
	// survives a router restart instead of resetting to zero. Sits next to
	// the router config by the same convention as pricingPath.
	economicsSnapshotPath string

	// stickyStore holds per-conversation cache-aware routing state for
	// RoutingModeSticky. Always constructed; only consulted when the Anthropic
	// passthrough routing mode is "sticky". See pkg/proxy/sticky_routing.go.
	stickyStore *sticky.Store
	// pricingTable is loaded once at startup so the sticky hysteresis can price
	// the prompt-cache invalidation cost of a switch without an on-demand load
	// per request. Nil when pricing.yaml is absent/unparseable, in which case
	// sticky hysteresis is skipped (the router's candidate model stands).
	pricingTable *economics.PricingTable

	// routingEventLog appends one JSONL record per routed request (mode,
	// candidate/served model, session identity, sticky switch delta, e2e
	// latency), feeding the offline promotion-gate aggregator. Nil when the
	// sink cannot be opened; append is then a no-op. Never affects serving.
	routingEventLog *routingEventLogger
	// routingEventPath is where routingEventLog writes, kept separately so the
	// /api/v1/routing/stats handler can read+aggregate the log even when the
	// writer is disabled (e.g. a prior run's file still on disk).
	routingEventPath string
}

// economicsSnapshotInterval is how often the economics store is flushed to
// disk while the server is running, in addition to the flush performed on
// graceful shutdown.
const economicsSnapshotInterval = 30 * time.Second

// stickyPruneInterval is how often expired sticky-store entries are swept.
// Lazy eviction on GetAt never fires for keys that are never re-read (e.g.
// one-shot routed subagents), so a periodic prune bounds memory. Cadence is a
// pure memory/CPU tradeoff, never correctness: Prune uses the same TTL
// predicate as GetAt, so a swept entry is one a read would already treat as
// absent.
const stickyPruneInterval = 60 * time.Second

// NewServer creates a new Brick proxy server. If a prior economics snapshot
// exists on disk (economics_snapshot.json next to configPath), it is loaded
// so token-usage counters survive a restart instead of resetting to zero; a
// missing file is not an error (fresh install / first run).
func NewServer(cfg *config.RouterConfig, configPath string, port int) *Server {
	store := economics.NewStore()
	snapshotPath := filepath.Join(filepath.Dir(configPath), "economics_snapshot.json")
	if err := store.LoadSnapshot(snapshotPath); err != nil {
		logging.Warnf("Economics: failed to load prior usage snapshot from %s: %v", snapshotPath, err)
	}

	pricingPath := filepath.Join(filepath.Dir(configPath), "pricing.yaml")

	// Append-only routing event log, next to the config by the same convention
	// as the economics snapshot. Best-effort: a failed open disables it.
	routingEventPath := filepath.Join(filepath.Dir(configPath), "routing_events.jsonl")
	routingEventLog := newRoutingEventLogger(routingEventPath)

	// Sticky routing state. The TTL comes from config so it can track the
	// upstream prompt-cache TTL (default 6 min, just over the 5-min cache TTL).
	stickyTTL := time.Duration(cfg.AnthropicPassthrough.EffectiveStickyTTLSeconds()) * time.Second

	// Preload the pricing table so sticky hysteresis can price a switch without
	// a per-request file read. Best-effort: a missing/invalid pricing.yaml just
	// disables the hysteresis (candidate model stands), it is never fatal.
	pricingTable, perr := economics.LoadPricingTable(pricingPath)
	if perr != nil {
		logging.Warnf("Sticky routing: pricing table not loaded (%v); cache-aware hysteresis disabled until pricing.yaml exists", perr)
		pricingTable = nil
	}

	return &Server{
		cfg:                   cfg,
		configPath:            configPath,
		port:                  port,
		economicsStore:        store,
		pricingPath:           pricingPath,
		economicsSnapshotPath: snapshotPath,
		stickyStore:           sticky.New(stickyTTL),
		pricingTable:          pricingTable,
		routingEventLog:       routingEventLog,
		routingEventPath:      routingEventPath,
	}
}

// EconomicsStore returns the server's economics usage store.
func (s *Server) EconomicsStore() *economics.Store {
	return s.economicsStore
}

// Start starts the HTTP server and blocks until shutdown.
func (s *Server) Start(ctx context.Context) error {
	mux := http.NewServeMux()

	// Register routes
	mux.HandleFunc("/v1/chat/completions", s.handleChatCompletions)
	// /v1/responses adapts the OpenAI Responses protocol (Codex CLI 0.134+ speaks
	// only this wire format) to the Chat Completions router core; see responses.go.
	mux.HandleFunc("/v1/responses", s.handleResponses)
	mux.HandleFunc("/v1/messages", s.handleAnthropicMessages) // Anthropic-native pass-through
	mux.HandleFunc("/v1/models", s.handleModels)
	mux.HandleFunc("/health", s.handleHealth)
	mux.HandleFunc("/v1/routing/test", s.handleRoutingTest)
	mux.HandleFunc("/api/v1/diag/classifier", s.handleDiagClassifier)
	mux.HandleFunc("/api/v1/metrics/reset", s.handleMetricsReset) // clear brick_cc_* routing counters
	mux.HandleFunc("/api/v1/economics", s.handleEconomics)        // token usage + real savings vs. all-expensive baseline
	mux.HandleFunc("/api/v1/routing/stats", s.handleRoutingStats) // per-mode routing event aggregates (promotion-gate harness)
	// Also expose Prometheus metrics on the main proxy port so `brick claude status`
	// can read routing stats without publishing the dedicated metrics port (9190).
	mux.Handle("/metrics", promhttp.Handler())

	// Wrap with CORS middleware
	handler := corsMiddleware(mux)

	s.httpServer = &http.Server{
		Addr:              fmt.Sprintf(":%d", s.port),
		Handler:           handler,
		ReadHeaderTimeout: 30 * time.Second,
	}

	logging.Infof("Brick proxy server starting on port %d", s.port)
	if cfg := s.cfg; cfg != nil && cfg.AnthropicPassthrough.Enabled {
		logging.Infof("AnthropicPassthrough: /v1/messages enabled, upstream=%s",
			cfg.AnthropicPassthrough.EffectiveUpstreamURL())
	}

	// Run server in goroutine
	errCh := make(chan error, 1)
	go func() {
		if err := s.httpServer.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			errCh <- err
		}
		close(errCh)
	}()

	// Periodically flush economics usage counters to disk so the real-savings
	// figure survives a restart. Stopped when the server context is cancelled.
	snapshotTicker := time.NewTicker(economicsSnapshotInterval)
	defer snapshotTicker.Stop()
	go func() {
		for {
			select {
			case <-ctx.Done():
				return
			case <-snapshotTicker.C:
				s.saveEconomicsSnapshot()
			}
		}
	}()

	// Periodically sweep expired sticky-store entries. Lazy eviction only fires
	// when a key is re-read; one-shot conversations (routed subagents) never
	// are, so without this the map grows monotonically. Behavior-preserving:
	// Prune uses the same TTL predicate as GetAt.
	pruneTicker := time.NewTicker(stickyPruneInterval)
	defer pruneTicker.Stop()
	go func() {
		for {
			select {
			case <-ctx.Done():
				return
			case <-pruneTicker.C:
				if s.stickyStore != nil {
					if n := s.stickyStore.Prune(time.Now()); n > 0 {
						logging.Debugf("sticky: pruned %d expired entries (live=%d)", n, s.stickyStore.Len())
					}
				}
			}
		}
	}()

	// Wait for context cancellation or server error
	select {
	case err := <-errCh:
		return fmt.Errorf("server error: %w", err)
	case <-ctx.Done():
		logging.Infof("Shutting down proxy server...")
		// Final flush so no usage accumulated since the last tick is lost.
		s.saveEconomicsSnapshot()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		return s.httpServer.Shutdown(shutdownCtx)
	}
}

// saveEconomicsSnapshot persists the economics usage counters to disk,
// logging (but not failing) on error. Safe to call with a nil store.
func (s *Server) saveEconomicsSnapshot() {
	if s.economicsStore == nil || s.economicsSnapshotPath == "" {
		return
	}
	if err := s.economicsStore.SaveSnapshot(s.economicsSnapshotPath); err != nil {
		logging.Warnf("Economics: failed to save usage snapshot to %s: %v", s.economicsSnapshotPath, err)
	}
}

// handleHealth returns a simple health check response.
func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	w.Write([]byte(`{"status":"ok"}`))
}

// handleMetricsReset clears the Brick→Claude Code pass-through routing counters
// (requests, effort, routing heatmap, classifier latency, fallback) AND the
// economics token/cost usage store, so `brick claude status` shows a fully
// fresh dashboard without restarting the router. POST-only. Only the
// brick_cc_* metrics and economics usage are cleared; all other Prometheus
// series are left intact. The economics snapshot on disk is rewritten
// immediately so a router restart does not silently reload the pre-reset
// totals (see saveEconomicsSnapshot).
func (s *Server) handleMetricsReset(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	metrics.ResetBrickCC()
	if s.economicsStore != nil {
		s.economicsStore.Reset()
		s.saveEconomicsSnapshot()
	}
	logging.Infof("Brick: routing metrics reset via /api/v1/metrics/reset")
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	w.Write([]byte(`{"status":"ok","reset":"brick_cc,economics"}`))
}

// handleModels returns the list of available models.
// The virtual Brick model is always listed first. Native Claude models are
// listed when the Anthropic passthrough is enabled, and configured skill-router
// models are listed when include_config_models_in_list is enabled (the Codex
// profile enables this so Codex's model picker can discover the Brick pool).
func (s *Server) handleModels(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}

	type modelEntry struct {
		ID      string `json:"id"`
		Object  string `json:"object"`
		OwnedBy string `json:"owned_by"`
	}

	poolLen := 0
	if s.cfg != nil {
		poolLen = len(s.cfg.SkillRouter.Models)
	}
	models := make([]modelEntry, 0, 1+poolLen+3)
	seen := make(map[string]bool)
	add := func(id, owner string) {
		if id == "" || seen[id] {
			return
		}
		seen[id] = true
		models = append(models, modelEntry{ID: id, Object: "model", OwnedBy: owner})
	}

	// Codex uses the configured auto_model_name (normally "brick"); keep the
	// Claude-specific alias for the Anthropic model picker as well.
	autoModel := "brick"
	if s.cfg != nil && s.cfg.AutoModelName != "" {
		autoModel = s.cfg.AutoModelName
	}
	add(autoModel, "brick")
	if s.cfg != nil && s.cfg.AnthropicPassthrough.Enabled {
		add("brick-claude", "brick")
		add("claude-opus-4-8", "anthropic")
		add("claude-sonnet-4-6", "anthropic")
		add("claude-haiku-4-5", "anthropic")
	}

	if s.cfg != nil && s.cfg.IncludeConfigModelsInList {
		for _, model := range s.cfg.SkillRouter.Models {
			add(model.Model, "brick")
		}
	}

	resp := map[string]interface{}{
		"object": "list",
		"data":   models,
	}

	w.Header().Set("Content-Type", "application/json")
	body, _ := json.Marshal(resp)
	w.Write(body)
}

// handleRoutingTest is a debug endpoint that runs the routing pipeline
// on a test message and returns the routing decision without forwarding.
func (s *Server) handleRoutingTest(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}

	if s.cfg == nil || !s.cfg.Brick.Enabled || !s.cfg.SkillRouter.Enabled {
		writeError(w, http.StatusBadRequest, "Brick routing is not enabled")
		return
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, maxRequestBodySize))
	if err != nil {
		writeError(w, http.StatusBadRequest, fmt.Sprintf("reading request body: %v", err))
		return
	}
	brickRouter, err := s.getBrickRouter(s.cfg)
	if err != nil {
		writeError(w, http.StatusInternalServerError, fmt.Sprintf("brick router error: %v", err))
		return
	}
	route, err := brickRouter.RouteWithCandidates(r.Context(), extractOpenAIRoutingText(body, s.cfg), brickFixedModelAllow(s.cfg))
	if err != nil {
		writeError(w, http.StatusInternalServerError, fmt.Sprintf("routing error: %v", err))
		return
	}
	resp := map[string]interface{}{
		"selected_model": route.Model,
		"reason":         route.Reason,
		"keyword_rule":   route.MatchedKeyword,
		"capability":     route.Capability,
		"complexity": map[string]interface{}{
			"label":      route.ComplexityLabel,
			"confidence": route.ComplexityConfidence,
			"tau":        route.TauQuery,
		},
		"scores": route.Scores,
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(resp)
}

// handleChatCompletions is the main request handler.
// It runs the routing pipeline, then either returns a direct response
// or forwards to the selected backend.
func (s *Server) handleChatCompletions(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}

	if s.cfg == nil || !s.cfg.Brick.Enabled {
		writeError(w, http.StatusBadRequest, "Brick gateway is not enabled")
		return
	}
	s.handleBrickRequest(w, r)
}

// corsMiddleware adds CORS headers to all responses.
func corsMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")

		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusOK)
			return
		}

		next.ServeHTTP(w, r)
	})
}
