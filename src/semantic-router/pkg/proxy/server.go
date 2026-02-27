package proxy

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"github.com/vllm-project/semantic-router/src/semantic-router/pkg/extproc"
	"github.com/vllm-project/semantic-router/src/semantic-router/pkg/observability/logging"
)

// Server is the HTTP proxy server that replaces Envoy.
// It receives OpenAI-compatible requests, runs them through the semantic routing
// pipeline (classification, decisions, PII/jailbreak checks, caching), then
// forwards to the selected backend and streams the response back.
type Server struct {
	router     *extproc.OpenAIRouter
	configPath string
	port       int
	httpServer *http.Server
}

// NewServer creates a new proxy server wrapping the given router.
func NewServer(router *extproc.OpenAIRouter, configPath string, port int) *Server {
	return &Server{
		router:     router,
		configPath: configPath,
		port:       port,
	}
}

// GetRouter returns the current router instance.
func (s *Server) GetRouter() *extproc.OpenAIRouter {
	return s.router
}

// Start starts the HTTP server and blocks until shutdown.
func (s *Server) Start(ctx context.Context) error {
	mux := http.NewServeMux()

	// Register routes
	mux.HandleFunc("/v1/chat/completions", s.handleChatCompletions)
	mux.HandleFunc("/v1/responses", s.handleChatCompletions) // Response API
	mux.HandleFunc("/v1/models", s.handleModels)
	mux.HandleFunc("/health", s.handleHealth)
	mux.HandleFunc("/v1/routing/test", s.handleRoutingTest)

	// Wrap with CORS middleware
	handler := corsMiddleware(mux)

	s.httpServer = &http.Server{
		Addr:              fmt.Sprintf(":%d", s.port),
		Handler:           handler,
		ReadHeaderTimeout: 30 * time.Second,
	}

	logging.Infof("MyModel proxy server starting on port %d", s.port)

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

// handleModels returns the list of available models.
func (s *Server) handleModels(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}

	cfg := s.router.Config
	if cfg == nil {
		writeError(w, http.StatusInternalServerError, "router config not loaded")
		return
	}

	// Build model list from backend models configuration
	type modelEntry struct {
		ID      string `json:"id"`
		Object  string `json:"object"`
		OwnedBy string `json:"owned_by"`
	}

	var models []modelEntry

	// When brick is enabled, expose only "brick" as the virtual model
	if cfg.Brick.Enabled {
		models = append(models, modelEntry{
			ID:      "brick",
			Object:  "model",
			OwnedBy: "regolo",
		})
	} else {
		// Add auto/virtual model names
		for _, name := range cfg.GetAutoModelNames() {
			models = append(models, modelEntry{
				ID:      name,
				Object:  "model",
				OwnedBy: "mymodel",
			})
		}

		// Add backend model names
		if cfg.BackendModels.ModelConfig != nil {
			for modelName := range cfg.BackendModels.ModelConfig {
				models = append(models, modelEntry{
					ID:      modelName,
					Object:  "model",
					OwnedBy: "backend",
				})
			}
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

	// When brick is enabled, rewrite "brick" → auto model name so the pipeline can process it
	if s.router.Config != nil && s.router.Config.Brick.Enabled {
		s.rewriteBrickModelForPipeline(r)
	}

	result, reqCtx, err := s.runPipeline(r)
	if err != nil {
		writeError(w, http.StatusInternalServerError, fmt.Sprintf("routing pipeline error: %v", err))
		return
	}

	// Build debug response
	debug := map[string]interface{}{
		"direct":    result.Direct,
		"endpoint":  result.ForwardEndpoint,
		"path":      result.ForwardPath,
		"streaming": result.IsStreaming,
		"headers":   result.ForwardHeaders,
		"vsr": map[string]interface{}{
			"selected_model":    reqCtx.VSRSelectedModel,
			"selected_decision": reqCtx.VSRSelectedDecisionName,
			"confidence":        reqCtx.VSRSelectedDecisionConfidence,
			"reasoning_mode":    reqCtx.VSRReasoningMode,
			"selection_method":  reqCtx.VSRSelectionMethod,
			"matched_keywords":  reqCtx.VSRMatchedKeywords,
			"matched_domains":   reqCtx.VSRMatchedDomains,
			"cache_hit":         reqCtx.VSRCacheHit,
		},
	}

	w.Header().Set("Content-Type", "application/json")
	body, _ := json.Marshal(debug)
	w.Write(body)
}

// handleChatCompletions is the main request handler.
// It runs the routing pipeline, then either returns a direct response
// or forwards to the selected backend.
func (s *Server) handleChatCompletions(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}

	// When brick mode is enabled, delegate to the brick handler
	if s.router.Config != nil && s.router.Config.Brick.Enabled {
		s.handleBrickRequest(w, r)
		return
	}

	result, _, err := s.runPipeline(r)
	if err != nil {
		logging.Errorf("Pipeline error: %v", err)
		writeError(w, http.StatusInternalServerError, fmt.Sprintf("routing error: %v", err))
		return
	}

	// Case 1: Direct response (error, cache hit, block)
	if result.Direct {
		for k, v := range result.Headers {
			w.Header().Set(k, v)
		}
		if w.Header().Get("Content-Type") == "" {
			w.Header().Set("Content-Type", "application/json")
		}
		w.WriteHeader(result.StatusCode)
		w.Write(result.Body)
		return
	}

	// Case 2: Forward to backend
	if result.ForwardEndpoint == "" {
		// No endpoint selected — fall through to direct backend
		// This happens when the model wasn't changed (no routing needed)
		writeError(w, http.StatusBadGateway, "no backend endpoint selected for model")
		return
	}

	s.forwardToBackend(w, r, result)
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

