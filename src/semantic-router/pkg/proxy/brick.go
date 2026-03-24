package proxy

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"

	"github.com/vllm-project/semantic-router/src/semantic-router/pkg/config"
	"github.com/vllm-project/semantic-router/src/semantic-router/pkg/headers"
	"github.com/vllm-project/semantic-router/src/semantic-router/pkg/multimodal"
	"github.com/vllm-project/semantic-router/src/semantic-router/pkg/observability/logging"
)

// handleBrickRequest is the main handler for the "brick" virtual model.
// It detects modality, preprocesses content, and either forwards directly
// to a specific model or routes through the semantic pipeline.
func (s *Server) handleBrickRequest(w http.ResponseWriter, r *http.Request) {
	// Read body with size limit to prevent OOM from oversized payloads
	body, err := io.ReadAll(io.LimitReader(r.Body, maxRequestBodySize))
	if err != nil {
		writeError(w, http.StatusBadRequest, fmt.Sprintf("reading request body: %v", err))
		return
	}
	defer r.Body.Close()

	if len(body) == 0 {
		writeError(w, http.StatusBadRequest, "empty request body")
		return
	}
	if len(body) >= maxRequestBodySize {
		writeError(w, http.StatusRequestEntityTooLarge,
			fmt.Sprintf("request body too large (max %d bytes)", maxRequestBodySize))
		return
	}

	// Parse minimal request fields
	var req struct {
		Model  string `json:"model"`
		Stream bool   `json:"stream"`
	}
	if err := json.Unmarshal(body, &req); err != nil {
		writeError(w, http.StatusBadRequest, fmt.Sprintf("invalid JSON: %v", err))
		return
	}

	cfg := s.router.Config
	if cfg == nil {
		writeError(w, http.StatusInternalServerError, "router config not loaded")
		return
	}

	// Check for x-selected-model header → bypass routing, forward directly
	if selectedModel := r.Header.Get("x-selected-model"); selectedModel != "" {
		// Validate that the model exists in the backend configuration
		if cfg.BackendModels.ModelConfig == nil {
			writeError(w, http.StatusBadRequest, "no backend models configured")
			return
		}
		if _, ok := cfg.BackendModels.ModelConfig[selectedModel]; !ok {
			writeError(w, http.StatusBadRequest,
				fmt.Sprintf("unknown model %q in x-selected-model header", selectedModel))
			return
		}
		logging.Infof("Brick: x-selected-model=%s, bypassing routing", selectedModel)
		rewrittenBody := rewriteModelInBody(body, selectedModel)
		clientKey := extractClientAPIKey(r)
		if clientKey == "" {
			writeError(w, http.StatusUnauthorized, "missing API key: provide Authorization Bearer token")
			return
		}
		result := s.buildRegoloForwardResultWithKey(rewrittenBody, cfg, req.Stream, clientKey)
		w.Header().Set(headers.VSRSelectedModel, selectedModel)
		s.forwardToBackend(w, r, result, "brick")
		return
	}

	// Validate model == "brick"
	if req.Model != "brick" {
		writeError(w, http.StatusBadRequest,
			fmt.Sprintf("Model '%s' is not supported. Use 'brick' as the model name.", req.Model))
		return
	}

	// API key must come from the client's Authorization header
	apiKey := extractClientAPIKey(r)
	if apiKey == "" {
		writeError(w, http.StatusUnauthorized, "missing API key: provide Authorization Bearer token")
		return
	}

	// Multimodal preprocessing
	brickCfg := &cfg.Brick
	preprocessResult, err := multimodal.Preprocess(r.Context(), body, brickCfg, apiKey)
	if err != nil {
		logging.Errorf("Brick preprocessing error: %v", err)
		writeError(w, http.StatusInternalServerError, fmt.Sprintf("preprocessing error: %v", err))
		return
	}

	// Case 1: Direct forward to a specific model (e.g., vision model for image+text)
	if preprocessResult.DirectModel != "" {
		endpoint := extractHost(preprocessResult.DirectEndpoint)
		if endpoint == "" {
			writeError(w, http.StatusInternalServerError,
				fmt.Sprintf("brick: no endpoint configured for direct model %q", preprocessResult.DirectModel))
			return
		}
		logging.Infof("Brick: direct forward to model=%s endpoint=%s",
			preprocessResult.DirectModel, endpoint)

		var forwardBody []byte
		if preprocessResult.PreserveOriginalBody {
			forwardBody = rewriteModelInBody(body, preprocessResult.DirectModel)
		} else {
			forwardBody = rewriteModelInBody(preprocessResult.RewrittenBody, preprocessResult.DirectModel)
		}

		result := &RoutingResult{
			ForwardBody:     forwardBody,
			ForwardEndpoint: endpoint,
			ForwardPath:     extractPath(preprocessResult.DirectEndpoint),
			ForwardHeaders: map[string]string{
				"Authorization": "Bearer " + apiKey,
			},
			IsStreaming: req.Stream,
		}
		w.Header().Set(headers.VSRSelectedModel, preprocessResult.DirectModel)
		s.forwardToBackend(w, r, result, "brick")
		return
	}

	// Case 2: Route through semantic pipeline
	// Rewrite "brick" → auto model name so the pipeline processes it
	autoName := cfg.GetEffectiveAutoModelName()
	pipelineBody := rewriteModelInBody(preprocessResult.RewrittenBody, autoName)
	logging.Infof("Brick: routing through pipeline with model=%s", autoName)

	// Reset r.Body so runPipeline can read it
	r.Body = io.NopCloser(bytes.NewReader(pipelineBody))
	r.ContentLength = int64(len(pipelineBody))

	// Run the standard routing pipeline
	result, reqCtx, err := s.runPipeline(r)
	if err != nil {
		logging.Errorf("Brick pipeline error: %v", err)
		writeError(w, http.StatusInternalServerError, fmt.Sprintf("routing error: %v", err))
		return
	}

	// Expose selected model via response header and server log
	if reqCtx != nil && reqCtx.VSRSelectedModel != "" {
		w.Header().Set(headers.VSRSelectedModel, reqCtx.VSRSelectedModel)
		logging.Infof("Brick: routed to model=%s decision=%s confidence=%.3f",
			reqCtx.VSRSelectedModel,
			reqCtx.VSRSelectedDecisionName,
			reqCtx.VSRSelectedDecisionConfidence)
	}

	// Adapt vLLM-specific reasoning parameters (chat_template_kwargs) to
	// OpenAI-compatible format (top-level thinking/reasoning_effort) for Regolo API.
	if result.ForwardBody != nil {
		result.ForwardBody = adaptForRegoloAPI(result.ForwardBody)
	}

	// Direct response from pipeline (cache hit, error, block)
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

	// In brick mode, all backends are behind Regolo API.
	// The pipeline may set ForwardEndpoint in Envoy style (e.g. "api.regolo.ai:443"
	// without schema), which forwardToBackend would turn into http:// on a TLS port.
	regoloResult := s.buildRegoloForwardResultWithKey(result.ForwardBody, cfg, req.Stream, apiKey)
	regoloResult.ForwardHeaders = mergeMaps(regoloResult.ForwardHeaders, result.ForwardHeaders)

	// Log brick auth injection (the pipeline's authz warnings above are expected —
	// brick injects the credential here, after the pipeline runs)
	keyPrefix := apiKey
	if len(keyPrefix) > 8 {
		keyPrefix = keyPrefix[:8] + "..."
	}
	logging.Infof("Brick: injected auth for upstream forward (key: %s)", keyPrefix)

	s.forwardToBackend(w, r, regoloResult, "brick")
}

// buildRegoloForwardResultWithKey creates a RoutingResult using the client-provided API key.
func (s *Server) buildRegoloForwardResultWithKey(body []byte, cfg *config.RouterConfig, isStreaming bool, apiKey string) *RoutingResult {
	baseURL, _ := getRegoloProviderInfo(cfg)

	return &RoutingResult{
		ForwardBody:     body,
		ForwardEndpoint: extractHost(baseURL),
		ForwardPath:     extractPath(baseURL) + "/chat/completions",
		ForwardHeaders: map[string]string{
			"Authorization": "Bearer " + apiKey,
		},
		IsStreaming: isStreaming,
	}
}

// getRegoloProviderInfo returns the base URL for the "regoloai" provider.
func getRegoloProviderInfo(cfg *config.RouterConfig) (baseURL, apiKey string) {
	baseURL = "https://api.regolo.ai/v1"
	if cfg != nil && cfg.Providers != nil {
		if p, ok := cfg.Providers["regoloai"]; ok && p != nil {
			if p.BaseURL != "" {
				baseURL = p.BaseURL
			}
			apiKey = p.APIKey
		}
	}
	return
}

// rewriteBrickModelForPipeline reads the request body, rewrites "brick" → auto model name,
// and resets r.Body. Used by the routing test endpoint.
func (s *Server) rewriteBrickModelForPipeline(r *http.Request) {
	body, err := io.ReadAll(io.LimitReader(r.Body, maxRequestBodySize))
	if err != nil || len(body) == 0 {
		return
	}
	r.Body.Close()

	var raw map[string]interface{}
	if err := json.Unmarshal(body, &raw); err != nil {
		r.Body = io.NopCloser(bytes.NewReader(body))
		return
	}

	if model, _ := raw["model"].(string); model == "brick" {
		autoName := s.router.Config.GetEffectiveAutoModelName()
		raw["model"] = autoName
		if rewritten, err := json.Marshal(raw); err == nil {
			body = rewritten
		}
	}

	r.Body = io.NopCloser(bytes.NewReader(body))
	r.ContentLength = int64(len(body))
}

// rewriteModelInBody replaces the "model" field in the JSON body.
func rewriteModelInBody(body []byte, newModel string) []byte {
	var raw map[string]interface{}
	if err := json.Unmarshal(body, &raw); err != nil {
		return body
	}
	raw["model"] = newModel
	result, err := json.Marshal(raw)
	if err != nil {
		return body
	}
	return result
}

// extractHost extracts scheme+host(:port) from a URL string.
// Returns e.g. "https://api.regolo.ai:443" so forwardToBackend
// sees the "http" prefix and doesn't prepend "http://".
// Handles IPv6 addresses, empty URLs, and missing schemes correctly.
func extractHost(rawURL string) string {
	if rawURL == "" {
		return ""
	}

	u, err := url.Parse(rawURL)
	if err != nil || u.Host == "" {
		return ""
	}

	scheme := u.Scheme
	if scheme == "" {
		scheme = "http"
	}

	host := u.Host
	// Add default port if missing. url.Parse preserves brackets for IPv6,
	// so u.Port() returns "" only when no port is specified.
	if u.Port() == "" {
		if scheme == "https" {
			host += ":443"
		} else {
			host += ":80"
		}
	}

	return scheme + "://" + host
}

// extractPath extracts the path from a URL string, or returns empty string.
// Handles IPv6, missing schemes, and empty URLs correctly.
func extractPath(rawURL string) string {
	if rawURL == "" {
		return ""
	}

	u, err := url.Parse(rawURL)
	if err != nil || u.Path == "" || u.Path == "/" {
		return ""
	}

	// Trim trailing slash for clean concatenation
	path := u.Path
	for len(path) > 1 && path[len(path)-1] == '/' {
		path = path[:len(path)-1]
	}
	return path
}

// extractClientAPIKey extracts the Bearer token from the client's Authorization header.
func extractClientAPIKey(r *http.Request) string {
	auth := r.Header.Get("Authorization")
	if auth == "" {
		return ""
	}
	const prefix = "Bearer "
	if strings.HasPrefix(auth, prefix) {
		return strings.TrimSpace(auth[len(prefix):])
	}
	return ""
}

// mergeMaps merges src into dst, returning dst. src values don't overwrite existing dst values.
func mergeMaps(dst, src map[string]string) map[string]string {
	if dst == nil {
		dst = make(map[string]string)
	}
	for k, v := range src {
		if _, exists := dst[k]; !exists {
			dst[k] = v
		}
	}
	return dst
}
