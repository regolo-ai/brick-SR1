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
}

// NewServer creates a new Brick proxy server.
func NewServer(cfg *config.RouterConfig, configPath string, port int) *Server {
	return &Server{
		cfg:            cfg,
		configPath:     configPath,
		port:           port,
		economicsStore: economics.NewStore(),
		pricingPath:    filepath.Join(filepath.Dir(configPath), "pricing.yaml"),
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
	// /v1/responses intentionally not registered: handleBrickRequest only
	// understands Chat Completions {messages:[...]} payloads and would silently
	// drop the Responses API `input` field.
	mux.HandleFunc("/v1/messages", s.handleAnthropicMessages) // Anthropic-native pass-through
	mux.HandleFunc("/v1/models", s.handleModels)
	mux.HandleFunc("/health", s.handleHealth)
	mux.HandleFunc("/v1/routing/test", s.handleRoutingTest)
	mux.HandleFunc("/api/v1/diag/classifier", s.handleDiagClassifier)
	mux.HandleFunc("/api/v1/metrics/reset", s.handleMetricsReset) // clear brick_cc_* routing counters
	mux.HandleFunc("/api/v1/economics", s.handleEconomics)        // token usage + real savings vs. all-expensive baseline
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

	// Wait for context cancellation or server error
	select {
	case err := <-errCh:
		return fmt.Errorf("server error: %w", err)
	case <-ctx.Done():
		logging.Infof("Shutting down proxy server...")
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		return s.httpServer.Shutdown(shutdownCtx)
	}
}

// handleHealth returns a simple health check response.
func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	w.Write([]byte(`{"status":"ok"}`))
}

// handleMetricsReset clears the Brick→Claude Code pass-through routing counters
// (requests, effort, routing heatmap, classifier latency, fallback) so
// `brick claude status` can show a fresh dashboard without restarting the
// router. POST-only. Only the brick_cc_* metrics are cleared; all other
// Prometheus series are left intact.
func (s *Server) handleMetricsReset(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	metrics.ResetBrickCC()
	logging.Infof("Brick: routing metrics reset via /api/v1/metrics/reset")
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	w.Write([]byte(`{"status":"ok","reset":"brick_cc"}`))
}

// handleModels returns the list of available models.
// The order matches what is most useful in Claude Code's model picker:
// brick-claude first (the smart router), then the three Claude models in
// descending capability order so users can still pick a model explicitly.
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

	models := []modelEntry{
		// Virtual Brick router — effort level controls routing mode (eco→max).
		{ID: "brick-claude", Object: "model", OwnedBy: "brick"},
		// Native Claude models: forwarded verbatim, no skill routing.
		{ID: "claude-opus-4-8", Object: "model", OwnedBy: "anthropic"},
		{ID: "claude-sonnet-4-6", Object: "model", OwnedBy: "anthropic"},
		{ID: "claude-haiku-4-5", Object: "model", OwnedBy: "anthropic"},
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
