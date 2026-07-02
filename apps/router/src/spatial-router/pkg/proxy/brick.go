package proxy

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"

	"github.com/regolo-ai/brick-SR1/apps/router/src/spatial-router/pkg/brickrouting"
	"github.com/regolo-ai/brick-SR1/apps/router/src/spatial-router/pkg/config"
	"github.com/regolo-ai/brick-SR1/apps/router/src/spatial-router/pkg/headers"
	"github.com/regolo-ai/brick-SR1/apps/router/src/spatial-router/pkg/multimodal"
	"github.com/regolo-ai/brick-SR1/apps/router/src/spatial-router/pkg/observability/logging"
	"github.com/regolo-ai/brick-SR1/apps/router/src/spatial-router/pkg/observability/metrics"
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

	cfg := s.cfg
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
		result := s.buildForwardResultForModel(rewrittenBody, cfg, selectedModel, req.Stream, clientKey)
		metrics.BrickCCRequests.WithLabelValues("native", selectedModel).Inc()
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

	// Capability-aware native passthrough: when the request carries raw image/
	// audio AND at least one configured model can consume that modality natively
	// (handles_images / handles_audio), route only among those models and forward
	// the ORIGINAL body unchanged, skipping OCR/STT flattening. If no model is
	// capable, fall through to the legacy preprocessing path below.
	if modality, derr := multimodal.DetectModality(body); derr == nil {
		if plan := decideMultimodalPlan(modality, cfg.SkillRouter.Models); plan.passthrough {
			brickRouter, brr := s.getBrickRouter(cfg)
			if brr != nil {
				logging.Errorf("Brick2 router init error: %v", brr)
				writeError(w, http.StatusInternalServerError, fmt.Sprintf("brick router error: %v", brr))
				return
			}
			routingText := extractOpenAIRoutingText(body, cfg)
			if strings.TrimSpace(routingText) == "" {
				routingText = multimodalRoutingPlaceholder(modality)
			}
			allow := intersectAllow(plan.allow, brickFixedModelAllow(cfg))
			route, rerr := brickRouter.RouteWithCandidates(r.Context(), routingText, allow)
			if rerr != nil {
				// Eligible set unexpectedly empty/failed: degrade gracefully to
				// the OCR/STT preprocessing path rather than erroring the request.
				logging.Warnf("Brick multimodal passthrough routing failed, falling back to preprocessing: %v", rerr)
			} else {
				forwardBody := rewriteModelInBody(body, route.Model)
				effortStr := ""
				if cfg.SkillRouter.DynamicEffort {
					level := autonomousEffortLevel(route.TauQuery, underCapacityForModel(route, route.Model), routingPreferenceOf(cfg))
					forwardBody, effortStr = applyBrickReasoningLevel(forwardBody, cfg, route.Model, level)
				}
				forwardBody = adaptForRegoloAPI(forwardBody)
				result := s.buildForwardResultForModel(forwardBody, cfg, route.Model, req.Stream, apiKey)
				recordBrickOpenAIRoute(cfg, route, route.Model, effortStr)
				w.Header().Set(headers.VSRSelectedModel, route.Model)
				if effortStr != "" {
					w.Header().Set("x-brick-effort", effortStr)
				}
				w.Header().Set("x-brick-route-reason", "multimodal_passthrough")
				logging.Infof("Brick2: multimodal passthrough model=%s reason=%s image=%v audio=%v",
					route.Model, route.Reason, modality.HasImage, modality.HasAudio)
				s.forwardToBackend(w, r, result, "brick")
				return
			}
		}
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
			Model:       preprocessResult.DirectModel,
		}
		w.Header().Set(headers.VSRSelectedModel, preprocessResult.DirectModel)
		s.forwardToBackend(w, r, result, "brick")
		return
	}

	// Case 2: Route text-derived content through Brick2 Skill-Vector router.
	brickRouter, err := s.getBrickRouter(cfg)
	if err != nil {
		logging.Errorf("Brick2 router init error: %v", err)
		writeError(w, http.StatusInternalServerError, fmt.Sprintf("brick router error: %v", err))
		return
	}

	routingText := extractOpenAIRoutingText(preprocessResult.RewrittenBody, cfg)
	route, err := brickRouter.RouteWithCandidates(r.Context(), routingText, brickFixedModelAllow(cfg))
	if err != nil {
		logging.Errorf("Brick2 routing error: %v", err)
		writeError(w, http.StatusInternalServerError, fmt.Sprintf("routing error: %v", err))
		return
	}

	forwardBody := rewriteModelInBody(preprocessResult.RewrittenBody, route.Model)
	effortStr := ""
	if cfg.SkillRouter.DynamicEffort {
		level := autonomousEffortLevel(route.TauQuery, underCapacityForModel(route, route.Model), routingPreferenceOf(cfg))
		forwardBody, effortStr = applyBrickReasoningLevel(forwardBody, cfg, route.Model, level)
	}
	forwardBody = adaptForRegoloAPI(forwardBody)

	regoloResult := s.buildForwardResultForModel(forwardBody, cfg, route.Model, req.Stream, apiKey)
	recordBrickOpenAIRoute(cfg, route, route.Model, effortStr)

	keyPrefix := apiKey
	if len(keyPrefix) > 8 {
		keyPrefix = keyPrefix[:8] + "..."
	}
	w.Header().Set(headers.VSRSelectedModel, route.Model)
	w.Header().Set("x-brick-route-reason", route.Reason)
	if effortStr != "" {
		w.Header().Set("x-brick-effort", effortStr)
	}
	if route.MatchedKeyword != "" {
		w.Header().Set("x-brick-keyword-rule", route.MatchedKeyword)
	}
	logging.Infof("Brick2: routed to model=%s reason=%s complexity=%s confidence=%.3f tau=%.3f effort=%s auth=%s",
		route.Model, route.Reason, route.ComplexityLabel, route.ComplexityConfidence, route.TauQuery, effortStr, keyPrefix)

	s.forwardToBackend(w, r, regoloResult, "brick")
}

// multimodalPlan is the decision of whether a request can be served by native
// passthrough (raw modality forwarded to a capable model) and, if so, the set
// of eligible models to route among.
type multimodalPlan struct {
	passthrough bool
	allow       map[string]bool
}

// decideMultimodalPlan inspects the detected modality and the configured models
// and decides whether native passthrough applies. A model is eligible only if
// it natively handles EVERY raw modality present (handles_images for image,
// handles_audio for audio). Text-only requests, or requests with no capable
// model, return passthrough=false so the caller uses the OCR/STT path.
func decideMultimodalPlan(modality multimodal.Modality, models []config.SkillRouterModelConfig) multimodalPlan {
	if !modality.HasImage && !modality.HasAudio {
		return multimodalPlan{} // text-only: normal routing, no passthrough
	}
	allow := make(map[string]bool)
	for _, m := range models {
		if modality.HasImage && !m.HandlesImages {
			continue
		}
		if modality.HasAudio && !m.HandlesAudio {
			continue
		}
		allow[m.Model] = true
	}
	if len(allow) == 0 {
		return multimodalPlan{} // no capable model: fall back to OCR/STT
	}
	return multimodalPlan{passthrough: true, allow: allow}
}

// multimodalRoutingPlaceholder yields a neutral routing prompt when a raw
// request carries no text of its own (e.g. an image-only message), so the
// router still has something to classify while selecting a capable model.
func multimodalRoutingPlaceholder(m multimodal.Modality) string {
	switch {
	case m.HasImage && m.HasAudio:
		return "Analyze the attached image and audio."
	case m.HasImage:
		return "Analyze the attached image."
	case m.HasAudio:
		return "Analyze the attached audio."
	default:
		return "Analyze the attached media."
	}
}

func brickFixedModelAllow(cfg *config.RouterConfig) map[string]bool {
	if cfg == nil || cfg.Brick.ModelRoutingEnabled() {
		return nil
	}
	model := cfg.Brick.EffectiveFixedModel(cfg.BackendModels.DefaultModel)
	return map[string]bool{model: true}
}

func intersectAllow(a, b map[string]bool) map[string]bool {
	if a == nil {
		return b
	}
	if b == nil {
		return a
	}
	out := make(map[string]bool)
	for model, ok := range a {
		if ok && b[model] {
			out[model] = true
		}
	}
	return out
}

func recordBrickOpenAIRoute(cfg *config.RouterConfig, route *brickrouting.Result, selectedModel, effortStr string) {
	if cfg == nil || route == nil || selectedModel == "" {
		return
	}
	label := route.ComplexityLabel
	if label == "" {
		label = "medium"
	}
	metrics.BrickCCRequests.WithLabelValues(label, selectedModel).Inc()
	if cfg.SkillRouter.DynamicEffort && effortStr != "" {
		metrics.BrickCCEffort.WithLabelValues(selectedModel, effortStr).Inc()
		metrics.BrickCCRouting.WithLabelValues(label, effortStr, selectedModel).Inc()
	}
}

func (s *Server) getBrickRouter(cfg *config.RouterConfig) (*brickrouting.Router, error) {
	s.brickRouterOnce.Do(func() {
		s.brickRouter, s.brickRouterErr = brickrouting.New(cfg)
	})
	return s.brickRouter, s.brickRouterErr
}

func extractOpenAIRoutingText(body []byte, cfg *config.RouterConfig) string {
	if cfg != nil && cfg.Brick.ContextWindow.Enabled {
		return extractOpenAIContextText(body, cfg.Brick.EffectiveContextWindowK())
	}
	return extractOpenAIText(body)
}

func extractOpenAIText(body []byte) string {
	var raw struct {
		Messages []interface{} `json:"messages"`
	}
	if err := json.Unmarshal(body, &raw); err != nil {
		return ""
	}
	return multimodal.ExtractText(raw.Messages)
}

type openAIMessageForRouting struct {
	Role    string      `json:"role"`
	Content interface{} `json:"content"`
}

func extractOpenAIContextText(body []byte, k int) string {
	if k <= 0 {
		k = 8
	}
	var raw struct {
		Messages []openAIMessageForRouting `json:"messages"`
	}
	if err := json.Unmarshal(body, &raw); err != nil {
		return ""
	}
	if len(raw.Messages) == 0 {
		return ""
	}

	start := 0
	turns := 0
	for i := len(raw.Messages) - 1; i >= 0; i-- {
		role := strings.ToLower(strings.TrimSpace(raw.Messages[i].Role))
		if role != "user" && role != "assistant" {
			continue
		}
		start = i
		if role == "user" {
			turns++
			if turns >= k {
				break
			}
		}
	}

	parts := make([]string, 0, len(raw.Messages)-start)
	for _, msg := range raw.Messages[start:] {
		role := strings.ToLower(strings.TrimSpace(msg.Role))
		if role != "user" && role != "assistant" {
			continue
		}
		text := strings.TrimSpace(openAIContentText(msg.Content))
		if text == "" {
			continue
		}
		parts = append(parts, role+": "+text)
	}
	return strings.Join(parts, "\n")
}

func openAIContentText(content interface{}) string {
	switch v := content.(type) {
	case string:
		return v
	case []interface{}:
		parts := make([]string, 0, len(v))
		for _, part := range v {
			m, ok := part.(map[string]interface{})
			if !ok {
				continue
			}
			if text, ok := m["text"].(string); ok && strings.TrimSpace(text) != "" {
				parts = append(parts, text)
				continue
			}
			if text, ok := m["input_text"].(string); ok && strings.TrimSpace(text) != "" {
				parts = append(parts, text)
			}
		}
		return strings.Join(parts, "\n")
	default:
		return ""
	}
}

// buildRegoloForwardResultWithKey creates a RoutingResult using the client-provided API key.
// Legacy: forwards to the global "regoloai" provider. Kept as fallback when the
// per-model BaseURL is not configured.
func (s *Server) buildRegoloForwardResultWithKey(body []byte, cfg *config.RouterConfig, isStreaming bool, apiKey string, modelName string) *RoutingResult {
	baseURL, _ := getRegoloProviderInfo(cfg)

	return &RoutingResult{
		ForwardBody:     body,
		ForwardEndpoint: extractHost(baseURL),
		ForwardPath:     extractPath(baseURL) + "/chat/completions",
		ForwardHeaders: map[string]string{
			"Authorization": "Bearer " + apiKey,
		},
		IsStreaming: isStreaming,
		Model:       modelName,
	}
}

// buildForwardResultForModel returns the forward target for the selected model.
// Lookup order:
//  1. If the model is in cfg.SkillRouter.Models and has BaseURL set,
//     forward there with the per-model resolved API key (env/file/literal,
//     falling back to the client key).
//  2. Otherwise fall back to the legacy regoloai forward.
//
// CustomParams from the model config are merged into the request body
// without overwriting fields already set by the client.
func (s *Server) buildForwardResultForModel(body []byte, cfg *config.RouterConfig, modelName string, isStreaming bool, clientKey string) *RoutingResult {
	modelCfg := findSkillRouterModel(cfg, modelName)
	if modelCfg == nil || modelCfg.BaseURL == "" {
		return s.buildRegoloForwardResultWithKey(body, cfg, isStreaming, clientKey, modelName)
	}
	mergedBody := mergeCustomParamsIntoBody(body, modelCfg.CustomParams)
	key := modelCfg.ResolveAPIKey(clientKey)
	return &RoutingResult{
		ForwardBody:     mergedBody,
		ForwardEndpoint: extractHost(modelCfg.BaseURL),
		ForwardPath:     extractPath(modelCfg.BaseURL) + "/chat/completions",
		ForwardHeaders: map[string]string{
			"Authorization": "Bearer " + key,
		},
		IsStreaming: isStreaming,
		Model:       modelName,
	}
}

func findSkillRouterModel(cfg *config.RouterConfig, name string) *config.SkillRouterModelConfig {
	if cfg == nil {
		return nil
	}
	for i := range cfg.SkillRouter.Models {
		if cfg.SkillRouter.Models[i].Model == name {
			return &cfg.SkillRouter.Models[i]
		}
	}
	return nil
}

// mergeCustomParamsIntoBody adds keys from custom into the JSON body, but
// never overwrites a key already present (client request wins).
func mergeCustomParamsIntoBody(body []byte, custom map[string]interface{}) []byte {
	if len(custom) == 0 {
		return body
	}
	var raw map[string]interface{}
	if err := json.Unmarshal(body, &raw); err != nil {
		return body
	}
	for k, v := range custom {
		if _, exists := raw[k]; !exists {
			raw[k] = v
		}
	}
	merged, err := json.Marshal(raw)
	if err != nil {
		return body
	}
	return merged
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
