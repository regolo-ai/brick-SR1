package proxy

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

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
	acceptedAt := time.Now().UTC()
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
	responseModel := "brick"
	if req.Model != "" && req.Model == cfg.AutoModelName {
		responseModel = req.Model
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
		clientKey, authErr := s.resolveClientAPIKey(r)
		if authErr != nil {
			writeError(w, http.StatusUnauthorized, authErr.Error())
			return
		}
		if clientKey == "" {
			writeError(w, http.StatusUnauthorized, missingAPIKeyMessage(s.cfg))
			return
		}
		result := s.buildForwardResultForModel(rewrittenBody, cfg, selectedModel, req.Stream, clientKey)
		result.AcceptedAt = acceptedAt
		result.RoutingSource, result.RoutingMode = "native", cfg.Brick.EffectiveRoutingMode()
		if writeDirectRoutingResult(w, result) {
			return
		}
		metrics.BrickCCRequests.WithLabelValues("native", selectedModel).Inc()
		w.Header().Set(headers.VSRSelectedModel, selectedModel)
		s.forwardToBackend(w, r, result, responseModel)
		return
	}

	// Accept the configured deployment name and the legacy Brick alias.
	autoModel := cfg.AutoModelName
	if autoModel == "" {
		autoModel = "brick"
	}
	if req.Model != "brick" && req.Model != autoModel {
		writeError(w, http.StatusBadRequest,
			fmt.Sprintf("Model '%s' is not supported. Use '%s' as the model name.", req.Model, autoModel))
		return
	}

	// Resolve the request credential from the configured proxy boundary or from
	// Authorization for direct deployments.
	apiKey, authErr := s.resolveClientAPIKey(r)
	if authErr != nil {
		writeError(w, http.StatusUnauthorized, authErr.Error())
		return
	}
	if apiKey == "" {
		writeError(w, http.StatusUnauthorized, missingAPIKeyMessage(s.cfg))
		return
	}

	r = r.WithContext(config.WithClientAPIKey(r.Context(), apiKey))

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
				writeError(w, http.StatusServiceUnavailable, fmt.Sprintf("brick router error: %v", brr))
				return
			}
			routingText := extractOpenAIRoutingText(body, cfg)
			if strings.TrimSpace(routingText) == "" {
				routingText = multimodalRoutingPlaceholder(modality)
			}
			allow := intersectAllow(plan.allow, brickFixedModelAllow(cfg))
			routingStarted := time.Now()
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
				} else {
					forwardBody = applyBrickReasoning(forwardBody, cfg, route.Model, route.ComplexityLabel)
				}
				forwardBody = adaptForRegoloAPI(forwardBody)
				result := s.buildForwardResultForModel(forwardBody, cfg, route.Model, req.Stream, apiKey)
				latency := time.Since(routingStarted).Milliseconds()
				result.AcceptedAt, result.Route, result.RoutingLatencyMS = acceptedAt, route, &latency
				result.RoutingSource, result.RoutingMode = "routed", cfg.Brick.EffectiveRoutingMode()
				result.ReasoningMode = effortStr
				if writeDirectRoutingResult(w, result) {
					return
				}
				recordBrickOpenAIRoute(cfg, route, route.Model, effortStr)
				w.Header().Set(headers.VSRSelectedModel, route.Model)
				if effortStr != "" {
					w.Header().Set("x-brick-effort", effortStr)
				}
				w.Header().Set("x-brick-route-reason", "multimodal_passthrough")
				logging.Infof("Brick2: multimodal passthrough model=%s reason=%s image=%v audio=%v",
					route.Model, route.Reason, modality.HasImage, modality.HasAudio)
				s.forwardToBackend(w, r, result, responseModel)
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

		key, keyErr := cfg.ResolveUpstreamAPIKey(preprocessResult.DirectModel, apiKey)
		if keyErr != nil {
			writeDirectRoutingResult(w, missingProviderCredentialResult(preprocessResult.DirectModel))
			return
		}
		result := &RoutingResult{
			ForwardBody:     forwardBody,
			ForwardEndpoint: endpoint,
			ForwardPath:     extractPath(preprocessResult.DirectEndpoint),
			ForwardHeaders: map[string]string{
				"Authorization": "Bearer " + key,
			},
			IsStreaming: req.Stream,
			Model:       preprocessResult.DirectModel,
		}
		result.AcceptedAt = acceptedAt
		result.RoutingSource, result.RoutingMode = "native", cfg.Brick.EffectiveRoutingMode()
		w.Header().Set(headers.VSRSelectedModel, preprocessResult.DirectModel)
		s.forwardToBackend(w, r, result, responseModel)
		return
	}

	// Case 2: Route text-derived content through Brick2 Skill-Vector router.
	brickRouter, err := s.getBrickRouter(cfg)
	if err != nil {
		logging.Errorf("Brick2 router init error: %v", err)
		writeError(w, http.StatusServiceUnavailable, fmt.Sprintf("brick router error: %v", err))
		return
	}

	routingText := extractOpenAIRoutingText(preprocessResult.RewrittenBody, cfg)
	routingStarted := time.Now()
	route, err := brickRouter.RouteWithCandidates(r.Context(), routingText, brickFixedModelAllow(cfg))
	if err != nil {
		logging.Errorf("Brick2 routing error: %v", err)
		writeError(w, http.StatusInternalServerError, fmt.Sprintf("routing error: %v", err))
		return
	}

	selectedModel := route.Model
	under := underCapacityForModel(route, selectedModel)
	stickyKey := ""
	switch cfg.Brick.EffectiveRoutingMode() {
	case config.RoutingModeSticky, config.RoutingModeSmartSqueeze:
		if cfg.Brick.ModelRoutingEnabled() {
			stickyKey, selectedModel, under, _ = s.applyBrickStickyRouting(&cfg.Brick, preprocessResult.RewrittenBody, route, selectedModel, under)
		}
	case config.RoutingModeOrchestrator:
		logShadowOrchestrator(len(preprocessResult.RewrittenBody), route, selectedModel)
	}

	forwardBody := rewriteModelInBody(preprocessResult.RewrittenBody, selectedModel)
	effortStr := ""
	if cfg.SkillRouter.DynamicEffort {
		level := autonomousEffortLevel(route.TauQuery, under, routingPreferenceOf(cfg))
		forwardBody, effortStr = applyBrickReasoningLevel(forwardBody, cfg, selectedModel, level)
	} else {
		forwardBody = applyBrickReasoning(forwardBody, cfg, selectedModel, route.ComplexityLabel)
	}
	forwardBody = adaptForRegoloAPI(forwardBody)

	regoloResult := s.buildForwardResultForModel(forwardBody, cfg, selectedModel, req.Stream, apiKey)
	regoloResult.StickyKey = stickyKey
	latency := time.Since(routingStarted).Milliseconds()
	regoloResult.AcceptedAt, regoloResult.Route, regoloResult.RoutingLatencyMS = acceptedAt, route, &latency
	regoloResult.RoutingSource, regoloResult.RoutingMode, regoloResult.ReasoningMode = "routed", cfg.Brick.EffectiveRoutingMode(), effortStr
	if writeDirectRoutingResult(w, regoloResult) {
		return
	}
	recordBrickOpenAIRoute(cfg, route, selectedModel, effortStr)

	w.Header().Set(headers.VSRSelectedModel, selectedModel)
	w.Header().Set("x-brick-route-reason", route.Reason)
	if effortStr != "" {
		w.Header().Set("x-brick-effort", effortStr)
	}
	if route.MatchedKeyword != "" {
		w.Header().Set("x-brick-keyword-rule", route.MatchedKeyword)
	}
	logging.Infof("Brick2: routed to model=%s reason=%s complexity=%s confidence=%.3f tau=%.3f effort=%s",
		selectedModel, route.Reason, route.ComplexityLabel, route.ComplexityConfidence, route.TauQuery, effortStr)

	s.forwardToBackend(w, r, regoloResult, responseModel)
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

func (s *Server) getBrickRouter(cfg *config.RouterConfig) (brickModelRouter, error) {
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

// buildRegoloForwardResult creates a RoutingResult using the current user credential.
// Legacy: forwards to the global "regoloai" provider. Kept as fallback when the
// per-model BaseURL is not configured.
func (s *Server) buildRegoloForwardResult(body []byte, cfg *config.RouterConfig, isStreaming bool, modelName, clientKey string) *RoutingResult {
	baseURL, _ := getRegoloProviderInfo(cfg)
	key, err := cfg.ResolveUpstreamAPIKey(modelName, clientKey)
	if err != nil {
		return missingProviderCredentialResult(modelName)
	}

	return &RoutingResult{
		ForwardBody:     body,
		ForwardEndpoint: extractHost(baseURL),
		ForwardPath:     extractPath(baseURL) + "/chat/completions",
		ForwardHeaders: map[string]string{
			"Authorization": "Bearer " + key,
		},
		IsStreaming: isStreaming,
		Model:       modelName,
	}
}

// buildForwardResultForModel returns the forward target for the selected model.
// Lookup order:
//  1. If the model is in cfg.SkillRouter.Models and has BaseURL set,
//     forward there with the client key for Regolo or the configured provider key.
//  2. Otherwise use the model_config provider profile and its authentication policy.
//  3. Otherwise use the legacy regoloai endpoint with the required client credential.
//
// CustomParams from the model config are merged into the request body
// without overwriting fields already set by the client.
func (s *Server) buildForwardResultForModel(body []byte, cfg *config.RouterConfig, modelName string, isStreaming bool, clientKey string) *RoutingResult {
	// model_config names are Brick's stable, internal identities. Before the
	// request leaves Brick translate an optional provider-specific external ID
	// (notably the legacy Regolo glm5.2-beta alias) while keeping Model below
	// unchanged for routing headers and economics attribution.
	externalModel := modelName
	if _, endpointName, found, err := cfg.SelectBestEndpointWithDetailsForModel(modelName); err == nil && found {
		externalModel = cfg.ResolveExternalModelID(modelName, endpointName)
	}
	forwardBody := rewriteModelInBody(body, externalModel)
	modelCfg := findSkillRouterModel(cfg, modelName)
	if modelCfg != nil && modelCfg.BaseURL != "" {
		mergedBody := mergeCustomParamsIntoBody(forwardBody, modelCfg.CustomParams)
		key, err := cfg.ResolveUpstreamAPIKey(modelName, clientKey)
		if err != nil {
			return missingProviderCredentialResult(modelName)
		}
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

	// Profiles created before inline per-skill endpoints existed express the
	// provider association only through model_config.preferred_endpoints. Honor
	// that association instead of silently sending every such model to the
	// legacy Regolo fallback. This is especially important for mixed pools.
	if _, endpointName, found, err := cfg.SelectBestEndpointWithDetailsForModel(modelName); err == nil && found {
		if profile, profileErr := cfg.GetProviderProfileForEndpoint(endpointName); profileErr == nil && profile != nil {
			if path, pathErr := profile.ResolveChatPath(); pathErr == nil {
				key, err := cfg.ResolveUpstreamAPIKey(modelName, clientKey)
				if err != nil {
					return missingProviderCredentialResult(modelName)
				}
				headerName, prefix, headerErr := profile.ResolveAuthHeader()
				if headerErr == nil {
					headers := make(map[string]string, len(profile.ExtraHeaders)+1)
					for name, value := range profile.ExtraHeaders {
						// HTTP header names are case-insensitive. A configured alias
						// must not overwrite the resolved request credential later.
						if key != "" && strings.EqualFold(name, headerName) {
							continue
						}
						headers[name] = value
					}
					if key != "" {
						if prefix != "" {
							headers[headerName] = prefix + " " + key
						} else {
							headers[headerName] = key
						}
					}
					return &RoutingResult{
						ForwardBody:     forwardBody,
						ForwardEndpoint: extractHost(profile.BaseURL),
						ForwardPath:     path,
						ForwardHeaders:  headers,
						IsStreaming:     isStreaming,
						Model:           modelName,
					}
				}
			}
		}
	}

	if _, configured := cfg.ModelConfig[modelName]; !configured && modelCfg == nil {
		return missingProviderCredentialResult(modelName)
	}
	return s.buildRegoloForwardResult(forwardBody, cfg, isStreaming, modelName, clientKey)
}

func missingProviderCredentialResult(model string) *RoutingResult {
	body, _ := json.Marshal(ErrorResponse{Error: ErrorDetail{
		Message: fmt.Sprintf("configured credential source is missing for provider-backed model %q", model),
		Type:    "upstream_configuration_error", Code: http.StatusBadGateway,
	}})
	return &RoutingResult{Direct: true, StatusCode: http.StatusBadGateway, Body: body,
		Headers: map[string]string{"Content-Type": "application/json"}, Model: model}
}

func writeDirectRoutingResult(w http.ResponseWriter, result *RoutingResult) bool {
	if result == nil || !result.Direct {
		return false
	}
	for name, value := range result.Headers {
		w.Header().Set(name, value)
	}
	w.WriteHeader(result.StatusCode)
	_, _ = w.Write(result.Body)
	return true
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

// extractClientAPIKey extracts the Bearer token from the Authorization header.
func extractClientAPIKey(r *http.Request) string {
	auth := r.Header.Get("Authorization")
	if auth == "" {
		return ""
	}
	const prefix = "Bearer "
	if strings.HasPrefix(auth, prefix) {
		key, _ := config.ValidateCredential(auth[len(prefix):])
		return key
	}
	return ""
}

// resolveClientAPIKey selects a request-scoped credential. When a trusted
// proxy header is configured, either that header or Authorization may be used,
// but conflicting values are rejected so proxy and direct credentials can
// never be confused.
func (s *Server) resolveClientAPIKey(r *http.Request) (string, error) {
	authorizationKey := extractClientAPIKey(r)
	if s == nil || s.cfg == nil || strings.TrimSpace(s.cfg.TrustedProxyHeader) == "" {
		return authorizationKey, nil
	}

	trustedValue := r.Header.Get(s.cfg.TrustedProxyHeader)
	trustedKey := ""
	if trustedValue != "" {
		var err error
		trustedKey, err = config.ValidateCredential(trustedValue)
		if err != nil {
			return "", fmt.Errorf("invalid trusted proxy credential")
		}
	}
	if trustedKey != "" && authorizationKey != "" && trustedKey != authorizationKey {
		return "", fmt.Errorf("conflicting request credentials")
	}
	if trustedKey != "" {
		return trustedKey, nil
	}
	return authorizationKey, nil
}

func missingAPIKeyMessage(cfg *config.RouterConfig) string {
	if cfg != nil && strings.TrimSpace(cfg.TrustedProxyHeader) != "" {
		return "missing API key: provide the trusted proxy credential or an Authorization Bearer token"
	}
	return "missing API key: provide Authorization Bearer token"
}
