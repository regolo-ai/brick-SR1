package proxy

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"time"

	"github.com/prometheus/client_golang/prometheus/promhttp"
	"github.com/regolo-ai/brick-SR1/apps/router/src/spatial-router/pkg/brickrouting"
	"github.com/regolo-ai/brick-SR1/apps/router/src/spatial-router/pkg/config"
	"github.com/regolo-ai/brick-SR1/apps/router/src/spatial-router/pkg/economics"
	"github.com/regolo-ai/brick-SR1/apps/router/src/spatial-router/pkg/observability/logging"
	"github.com/regolo-ai/brick-SR1/apps/router/src/spatial-router/pkg/observability/metrics"
	"github.com/regolo-ai/brick-SR1/apps/router/src/spatial-router/pkg/pricing"
	systemone "github.com/regolo-ai/brick-SR1/systemone"
)

type brickModelRouter interface {
	RouteWithOptions(context.Context, string, brickrouting.RoutingOptions) (*brickrouting.Result, error)
}

// Server is the Brick HTTP proxy server.
// It exposes OpenAI-compatible endpoints and routes requests through SystemOne.
type Server struct {
	instanceID     string
	profile        string
	version        string
	routingChecked atomic.Bool
	cfg            *config.RouterConfig
	configPath     string
	port           int
	httpServer     *http.Server

	// routerMu guards lazy (re)initialization of the SystemOne-backed router.
	// It replaces a sync.Once so a transient failure or a dead worker can be
	// recovered without restarting the process.
	routerMu           sync.Mutex
	brickRouter        brickModelRouter
	brickRouterErr     error
	brickRouterRetryAt time.Time
	brickRouterBackoff time.Duration

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

	pricingRefresher *pricing.Refresher

	// callHistory is the durable source of truth for the JSON stats API.
	callHistory *callHistory
}

// economicsSnapshotInterval is how often the economics store is flushed to
// disk while the server is running, in addition to the flush performed on
// graceful shutdown.
const economicsSnapshotInterval = 30 * time.Second

// NewServer creates a new Brick proxy server. If a prior economics snapshot
// exists on disk (economics_snapshot.json next to configPath), it is loaded
// so token-usage counters survive a restart instead of resetting to zero; a
// missing file is not an error (fresh install / first run).
func NewServer(cfg *config.RouterConfig, configPath string, port int, dataDirs ...string) *Server {
	dataDir := filepath.Dir(configPath)
	if len(dataDirs) > 0 && dataDirs[0] != "" {
		dataDir = dataDirs[0]
	}
	store := economics.NewStore()
	snapshotPath := filepath.Join(dataDir, "economics_snapshot.json")
	if err := store.LoadSnapshot(snapshotPath); err != nil {
		logging.Warnf("Economics: failed to load prior usage snapshot from %s: %v", snapshotPath, err)
	}

	pricingPath := filepath.Join(dataDir, "pricing.yaml")

	callHistory := newCallHistory(filepath.Join(dataDir, "call_history.jsonl"))

	pricingTable, _ := economics.LoadPricingTable(pricingPath)
	// Native Go pricing refresher (OpenRouter + Regolo). Replaces the Python
	// subprocess approach. Fetches directly from OpenRouter API with 1h cache TTL.
	pricingRefresher := pricing.NewRefresher(os.Getenv("OPENROUTER_API_KEY"))
	if pricingTable != nil {
		pricingRefresher.SetTable(pricingTable)
	}

	return &Server{
		cfg:                   cfg,
		configPath:            configPath,
		port:                  port,
		economicsStore:        store,
		pricingPath:           pricingPath,
		economicsSnapshotPath: snapshotPath,
		pricingRefresher:      pricingRefresher,
		callHistory:           callHistory,
	}
}

// EconomicsStore returns the server's economics usage store.
func (s *Server) EconomicsStore() *economics.Store {
	return s.economicsStore
}

// Start starts the HTTP server and blocks until shutdown.
func (s *Server) SetRuntimeIdentity(id, profile, version string) {
	s.instanceID, s.profile, s.version = id, profile, version
}

func (s *Server) Start(ctx context.Context) error {
	runCtx, cancelRun := context.WithCancel(ctx)
	defer cancelRun()
	ctx = runCtx

	go func() {
		if !s.routingNeedsInference() {
			s.routingChecked.Store(true)
			return
		}
		for {
			if _, err := s.getBrickRouter(s.cfg); err == nil {
				s.routingChecked.Store(true)
				return
			} else {
				logging.Warnf("Routing unavailable: %v", err)
			}
			s.routingChecked.Store(true)
			select {
			case <-ctx.Done():
				return
			case <-time.After(2 * time.Second):
			}
		}
	}()

	if s.pricingRefresher != nil {
		go s.pricingRefresher.Start(ctx)
	}

	mux := http.NewServeMux()

	// Register routes
	mux.HandleFunc("/v1/chat/completions", s.handleChatCompletions)
	// /v1/responses adapts the OpenAI Responses protocol (Codex CLI 0.134+ speaks
	// only this wire format) to the Chat Completions router core; see responses.go.
	mux.HandleFunc("/v1/responses", s.handleResponses)
	mux.HandleFunc("/v1/responses/compact", func(w http.ResponseWriter, r *http.Request) {
		if s.cfg == nil || !s.cfg.CodexRouter.Enabled {
			writeError(w, 404, "not found")
			return
		}
		s.handleCodexResponses(w, r)
	})
	mux.HandleFunc("/v1/messages", s.handleAnthropicMessages) // Anthropic-native pass-through
	mux.HandleFunc("/v1/models", s.handleModels)
	mux.HandleFunc("/health", s.handleHealth)
	mux.HandleFunc("/v1/routing/test", s.handleRoutingTest)
	mux.HandleFunc("/api/v1/diag/systemone", s.handleDiagSystemOne)
	mux.HandleFunc("/api/v1/metrics/reset", s.handleMetricsReset) // clear Brick routing routing counters
	mux.HandleFunc("/api/v1/economics", s.handleEconomics)        // token usage + real savings vs. all-expensive baseline
	mux.HandleFunc("/api/v1/stats", s.handleStats)
	mux.HandleFunc("/api/v1/stats/all", s.handleStats)
	mux.HandleFunc("/api/v1/stats/clear", s.handleStats)
	// Also expose Prometheus metrics on the main proxy port so `brick claude status`
	// can read routing stats without publishing the dedicated metrics port (9190).
	mux.Handle("/metrics", promhttp.Handler())

	// Wrap with CORS middleware
	handler := corsMiddleware(mux)

	listenAddress := fmt.Sprintf("127.0.0.1:%d", s.port)
	if s.cfg != nil && s.cfg.CodexRouter.Enabled {
		listenAddress = fmt.Sprintf("127.0.0.1:%d", s.port)
	}
	s.httpServer = &http.Server{
		Addr:              listenAddress,
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

// routingNeedsInference reports whether this profile routes through SystemOne.
func (s *Server) routingNeedsInference() bool {
	cfg := s.cfg
	return cfg != nil && cfg.SkillRouter.Enabled &&
		((cfg.Brick.Enabled || cfg.CodexRouter.Enabled) && cfg.Brick.ModelRoutingEnabled() ||
			cfg.AnthropicPassthrough.Enabled && cfg.AnthropicPassthrough.ModelRoutingEnabled())
}

// routingReady reflects the live worker state instead of a one-shot startup
// flag, so a worker that died mid-run is reported as not ready.
func (s *Server) routingReady() bool {
	if !s.routingNeedsInference() {
		return true
	}
	return systemone.Available()
}

// handleHealth returns a simple health check response.
func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	body := map[string]interface{}{"status": "ok", "instance_id": s.instanceID, "profile": s.profile, "version": s.version, "pid": os.Getpid(), "config": s.configPath, "routing_ready": s.routingReady(), "routing_checked": s.routingChecked.Load()}
	if s.cfg != nil && s.cfg.CodexRouter.Enabled {
		body["codex_router"] = "native-responses-v1"
		body["authentication"] = "not_probed"
		body["capability"] = "not_probed"
	}
	json.NewEncoder(w).Encode(body)
}

// handleMetricsReset clears the Brick→Claude Code pass-through routing counters
// request and SystemOne latency metrics, together with economics usage.
func (s *Server) handleMetricsReset(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	metrics.ResetRouting()
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
		ID                       string `json:"id"`
		Slug                     string `json:"slug"`
		Object                   string `json:"object"`
		OwnedBy                  string `json:"owned_by"`
		DisplayName              string `json:"display_name"`
		DefaultReasoningLevel    string `json:"default_reasoning_level"`
		SupportedReasoningLevels []struct {
			Effort      string `json:"effort"`
			Description string `json:"description"`
		} `json:"supported_reasoning_levels"`
		ShellType            string   `json:"shell_type"`
		Visibility           string   `json:"visibility"`
		SupportedInAPI       bool     `json:"supported_in_api"`
		Priority             int      `json:"priority"`
		AdditionalSpeedTiers []string `json:"additional_speed_tiers"`
		ServiceTiers         []struct {
			ID          string `json:"id"`
			Name        string `json:"name"`
			Description string `json:"description"`
		} `json:"service_tiers"`
		AvailabilityNUX  interface{} `json:"availability_nux"`
		Upgrade          interface{} `json:"upgrade"`
		BaseInstructions string      `json:"base_instructions"`
		Description      string      `json:"description"`
		ModelMessages    struct {
			InstructionsTemplate  string      `json:"instructions_template"`
			InstructionsVariables interface{} `json:"instructions_variables"`
			Approvals             interface{} `json:"approvals"`
			AutoReview            interface{} `json:"auto_review"`
			Permissions           interface{} `json:"permissions"`
		} `json:"model_messages"`
		IncludeSkillsUsageInstructions bool   `json:"include_skills_usage_instructions"`
		DefaultReasoningSummary        string `json:"default_reasoning_summary"`
		SupportVerbosity               bool   `json:"support_verbosity"`
		DefaultVerbosity               string `json:"default_verbosity"`
		ApplyPatchToolType             string `json:"apply_patch_tool_type"`
		WebSearchToolType              string `json:"web_search_tool_type"`
		TruncationPolicy               struct {
			Mode  string `json:"mode"`
			Limit int    `json:"limit"`
		} `json:"truncation_policy"`
		SupportsParallelToolCalls   bool     `json:"supports_parallel_tool_calls"`
		SupportsImageDetailOriginal bool     `json:"supports_image_detail_original"`
		ContextWindow               int      `json:"context_window"`
		MaxContextWindow            int      `json:"max_context_window"`
		CompHash                    string   `json:"comp_hash"`
		EffectiveContextWindowPct   int      `json:"effective_context_window_percent"`
		ExperimentalSupportedTools  []string `json:"experimental_supported_tools"`
		InputModalities             []string `json:"input_modalities"`
		SupportsSearchTool          bool     `json:"supports_search_tool"`
		UseResponsesLite            bool     `json:"use_responses_lite"`
		ToolMode                    string   `json:"tool_mode"`
		MultiAgentVersion           string   `json:"multi_agent_version"`
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
		reasoning := []struct {
			Effort      string `json:"effort"`
			Description string `json:"description"`
		}{
			{Effort: "low", Description: "Fast responses with lighter reasoning"},
			{Effort: "medium", Description: "Balances speed and reasoning depth"},
			{Effort: "high", Description: "Greater reasoning depth for complex tasks"},
		}
		serviceTiers := []struct {
			ID          string `json:"id"`
			Name        string `json:"name"`
			Description string `json:"description"`
		}{{ID: "priority", Name: "Fast", Description: "Priority service tier"}}
		entry := modelEntry{
			ID: id, Slug: id, Object: "model", OwnedBy: owner, DisplayName: id,
			DefaultReasoningLevel: "low", SupportedReasoningLevels: reasoning,
			ShellType: "shell_command", Visibility: "hide", SupportedInAPI: true,
			AdditionalSpeedTiers: []string{"fast"}, ServiceTiers: serviceTiers,
			Description: "Brick local router", DefaultReasoningSummary: "none",
			SupportVerbosity: true, DefaultVerbosity: "low", ApplyPatchToolType: "freeform",
			WebSearchToolType: "text_and_image", SupportsParallelToolCalls: true,
			SupportsImageDetailOriginal: true, ContextWindow: 272000, MaxContextWindow: 272000,
			CompHash: "brick", EffectiveContextWindowPct: 95, ExperimentalSupportedTools: []string{},
			InputModalities: []string{"text"}, SupportsSearchTool: false, UseResponsesLite: true,
			ToolMode: "code_mode_only", MultiAgentVersion: "v2",
		}
		entry.TruncationPolicy.Mode = "tokens"
		entry.TruncationPolicy.Limit = 10000
		entry.ModelMessages.InstructionsTemplate = ""
		models = append(models, entry)
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
		// Codex CLI's model manager accepts the OpenAI `data` list but also
		// requires this compatibility alias when refreshing a custom provider.
		// Keep both shapes pointing at the same entries.
		"models": models,
	}

	w.Header().Set("Content-Type", "application/json")
	body, _ := json.Marshal(resp)
	w.Write(body)
}

// handleRoutingTest is a debug endpoint that runs the routing pipeline
// on a test message and returns the routing decision without forwarding.
func (s *Server) handleRoutingTest(w http.ResponseWriter, r *http.Request) {
	clientKey, authErr := s.resolveClientAPIKey(r)
	if authErr != nil {
		writeError(w, http.StatusUnauthorized, authErr.Error())
		return
	}
	r = r.WithContext(config.WithClientAPIKey(r.Context(), clientKey))
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}

	if s.cfg == nil || !s.cfg.SkillRouter.Enabled {
		writeError(w, http.StatusBadRequest, "Brick routing is not enabled")
		return
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, maxRequestBodySize))
	if err != nil {
		writeError(w, http.StatusBadRequest, fmt.Sprintf("reading request body: %v", err))
		return
	}
	fixed := ""
	if s.cfg.AnthropicPassthrough.Enabled && !s.cfg.AnthropicPassthrough.ModelRoutingEnabled() {
		fixed = s.cfg.AnthropicPassthrough.EffectiveFixedModel()
	} else if !s.cfg.Brick.ModelRoutingEnabled() {
		fixed = s.cfg.Brick.EffectiveFixedModel(s.cfg.DefaultModel)
	}
	if fixed != "" {
		writeJSON(w, 200, map[string]interface{}{"selected_model": fixed, "source": "fixed_model", "knob": s.cfg.SkillRouter.Knob})
		return
	}
	brickRouter, err := s.getBrickRouter(s.cfg)
	if err != nil {
		writeError(w, http.StatusServiceUnavailable, fmt.Sprintf("brick router unavailable: %v", err))
		return
	}
	options, err := requestRoutingOptions(r, body, nil)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	options.KeywordText = keywordText(extractOpenAILastUserText(body))
	route, err := brickRouter.RouteWithOptions(r.Context(), extractOpenAIRoutingText(body, s.cfg), options)
	if err != nil {
		writeRoutingError(w, err, "SystemOne routing failed")
		return
	}
	effort := clampEffortToAllowed(knobToEffort(route.Knob), s.cfg.GetAllowedThinkingModes(route.Model))
	knobSource := "profile"
	if options.Knob != nil {
		knobSource = "request"
		if r.Header.Get(KnobHeader) != "" {
			knobSource = "header"
		} else {
			knobSource = "effort"
		}
	}
	source := route.Reason
	if source == "" {
		source = "classifier"
	}
	resp := map[string]interface{}{
		"selected_model": route.Model,
		"source":         source,
		"matched_rule":   route.MatchedRule,
		"query_vector":   route.QueryVector, "scaled_vector": route.ScaledVector,
		"knob": route.Knob, "effort": effort, "knob_source": knobSource, "distances": route.Distances,
	}
	if forwarded := requestEffort(applyKnobEffort(body, s.cfg, route.Model, route.Knob)); forwarded != "" {
		resp["forwarded_effort"] = forwarded
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
