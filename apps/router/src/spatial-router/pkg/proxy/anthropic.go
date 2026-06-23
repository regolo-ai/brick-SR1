package proxy

import (
	"bytes"
	"context"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/regolo-ai/brick-SR1/apps/router/src/spatial-router/pkg/brickrouting"
	"github.com/regolo-ai/brick-SR1/apps/router/src/spatial-router/pkg/config"
	"github.com/regolo-ai/brick-SR1/apps/router/src/spatial-router/pkg/observability/logging"
	"github.com/regolo-ai/brick-SR1/apps/router/src/spatial-router/pkg/observability/metrics"
)

// anthropicHTTPClient is the upstream client used to forward Anthropic-native
// /v1/messages requests. A long timeout (15 min) accommodates streaming
// responses that span the full max_tokens window.
var anthropicHTTPClient = &http.Client{
	Timeout: 15 * time.Minute,
	Transport: &http.Transport{
		TLSClientConfig:     &tls.Config{MinVersion: tls.VersionTLS12},
		MaxIdleConns:        50,
		MaxIdleConnsPerHost: 10,
		IdleConnTimeout:     90 * time.Second,
		DisableCompression:  true, // SSE does not benefit from gzip and breaks Flush semantics
	},
}

// hopByHopHeaders MUST NOT be forwarded across a proxy hop (RFC 7230 §6.1).
var hopByHopHeaders = map[string]struct{}{
	"Connection":          {},
	"Proxy-Connection":    {},
	"Keep-Alive":          {},
	"Proxy-Authenticate":  {},
	"Proxy-Authorization": {},
	"Te":                  {},
	"Trailer":             {},
	"Transfer-Encoding":   {},
	"Upgrade":             {},
	"Host":                {},
	"Content-Length":      {},
	"Accept-Encoding":     {},
}

// handleAnthropicMessages implements a transparent pass-through for the
// Anthropic /v1/messages endpoint. The request body and headers (including
// Authorization, anthropic-version, anthropic-beta, User-Agent) are forwarded
// verbatim to the configured upstream.
//
// Model selection logic:
//   - If the client sends model="brick-claude" (or any "brick-*" prefix), Brick
//     runs the full skill router. The client's output_config.effort is mapped to
//     a routing preference r that drives ONLY model selection (RouteWithPreference),
//     letting the Claude Code effort picker act as the Brick mode selector. The
//     reasoning effort injected into the request is then computed autonomously by
//     the router's own signals (autonomousEffortLevel), independent of the mode.
//   - If the client sends a native Claude model (haiku/sonnet/opus), Brick
//     forwards the request verbatim to that model — no skill routing, no effort
//     override. This preserves the user's explicit model choice.
func (s *Server) handleAnthropicMessages(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}

	cfg := s.cfg
	if cfg == nil {
		writeError(w, http.StatusInternalServerError, "router config not loaded")
		return
	}
	apCfg := &cfg.AnthropicPassthrough
	if !apCfg.Enabled {
		writeError(w, http.StatusNotFound, "anthropic_passthrough is disabled")
		return
	}

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

	requestedModel := extractRequestedModel(body)
	clientEffort := extractClientEffort(body)

	// Classify the request as "brick-routed" vs "native-model passthrough".
	// brick-routed: model field is empty, "brick-*", or "brick" (all the names
	//   we publish in /v1/models for the virtual router entry).
	// native: any recognized claude-* model; forwarded verbatim, UNLESS
	//   RouteSubagents is on, in which case explicit native models (typical of
	//   Claude Code subagents) are also sent through the skill router.
	isBrick := requestedModel == "" ||
		strings.HasPrefix(strings.ToLower(requestedModel), "brick") ||
		(apCfg.RouteSubagents && isNativeClaudeModel(requestedModel))

	if isBrick {
		s.handleBrickRouted(w, r, cfg, apCfg, body, clientEffort)
	} else {
		s.handleNativeModel(w, r, cfg, apCfg, body, requestedModel)
	}
}

// isNativeClaudeModel reports whether the requested model is an explicit Claude
// model name (e.g. "claude-haiku-4-5"). Used to decide whether subagent traffic
// that arrives with a concrete model should be pulled into the skill router when
// RouteSubagents is enabled.
func isNativeClaudeModel(model string) bool {
	return strings.Contains(strings.ToLower(model), "claude-")
}

// handleBrickRouted processes a /v1/messages request whose model field maps to
// the Brick virtual router. It derives a routing preference from the client's
// effort level (which selects the MODEL via RouteWithPreference), then injects a
// reasoning effort computed autonomously from the router's own signals (query
// difficulty + how stretched the chosen model is), independent of the mode.
func (s *Server) handleBrickRouted(
	w http.ResponseWriter, r *http.Request,
	cfg *config.RouterConfig, apCfg *config.AnthropicPassthroughConfig,
	body []byte, clientEffort string,
) {
	var prompt string
	if apCfg.ContextWindow.Enabled {
		prompt = extractAnthropicContextText(body, apCfg.EffectiveContextWindowK())
	} else {
		prompt = extractAnthropicPromptText(body)
	}
	if prompt == "" {
		logging.Warnf("AnthropicPassthrough[brick]: could not extract prompt text, falling back to medium")
	}

	// Derive routing preference from the client's effort selection (or default to
	// mid). This drives ONLY model selection; the effort injected below is computed
	// autonomously and does not depend on the mode.
	preference := clientEffortToPreference(clientEffort)

	label := "medium"
	if prompt != "" {
		label = classifyAnthropicComplexity(r.Context(), cfg, prompt)
	}

	clientWants1M := requestRequestsContext1M(r.Header.Values("Anthropic-Beta"))
	use1M := clientWants1M && apCfg.ExtraUsageEnabled && len(body) > apCfg.EffectiveContext1MThresholdBytes()

	// Model selection: full Brick skill router with per-request preference override.
	// tauQuery and under capture the autonomous-effort signals from the route.
	var selectedModel string
	var complexityLabel string
	var tauQuery, under float64
	routedViaSkill := false
	if apCfg.UseSkillRouter && cfg.SkillRouter.Enabled && prompt != "" {
		if router, rerr := s.getBrickRouter(cfg); rerr != nil {
			logging.Warnf("AnthropicPassthrough[brick]: skill router init failed, falling back to model_map: %v", rerr)
		} else if route, rerr := router.RouteWithPreference(r.Context(), prompt, preference); rerr != nil {
			logging.Warnf("AnthropicPassthrough[brick]: skill router failed, falling back to model_map: %v", rerr)
		} else {
			selectedModel = route.Model
			complexityLabel = route.ComplexityLabel
			if complexityLabel == "easy" || complexityLabel == "medium" || complexityLabel == "hard" {
				label = complexityLabel
			}
			tauQuery = route.TauQuery
			under = underCapacityForModel(route, route.Model)
			routedViaSkill = true
		}
	}
	if selectedModel == "" {
		if use1M {
			selectedModel = apCfg.Resolve1M(label)
		} else {
			selectedModel = apCfg.Resolve(label)
		}
	}

	metrics.BrickCCRequests.WithLabelValues(label, selectedModel).Inc()

	// Strip the 1M-context beta when the account lacks the extra-usage tier, OR
	// whenever the selected model has no 1M variant (Haiku) — forwarding it would
	// trigger an "Extra usage is required for 1M context" upstream error.
	stripBeta := !use1M || strings.Contains(strings.ToLower(selectedModel), "haiku")

	rewritten := rewriteModelInBody(body, selectedModel)
	effortStr := ""
	if routedViaSkill && cfg.SkillRouter.DynamicEffort {
		// Autonomous effort: difficulty + chosen-model headroom, NO mode window.
		level := autonomousEffortLevel(tauQuery, under)
		rewritten = applyEffortAnthropicLevel(rewritten, level, selectedModel)
		effortStr = vocabAt(claudeVocabForModel(selectedModel), level)
		metrics.BrickCCEffort.WithLabelValues(selectedModel, effortStr).Inc()
	}
	rewritten = stripUnsupportedFieldsForModel(rewritten, selectedModel)

	logging.Infof("AnthropicPassthrough[brick]: mode_effort=%s preference=%.2f complexity=%s tau=%.3f under=%.3f auto_effort=%s model=%s use_1m=%t bytes=%d",
		clientEffort, preference, label, tauQuery, under, effortStr, selectedModel, use1M, len(rewritten))

	s.forwardAnthropicRequest(w, r, apCfg, rewritten, selectedModel, label, effortStr, routedViaSkill, stripBeta)
}

// underCapacityForModel returns the under-capacity residual of the named model
// from the route's score list (how far its skill falls short of the lifted
// query requirement). Falls back to the top-ranked model's residual, then 0,
// when the model is not present (e.g. a keyword override outside the scored set).
func underCapacityForModel(route *brickrouting.Result, model string) float64 {
	for _, s := range route.Scores {
		if s.Model == model {
			return s.UnderCapacity
		}
	}
	if len(route.Scores) > 0 {
		return route.Scores[0].UnderCapacity
	}
	return 0
}

// handleNativeModel forwards a /v1/messages request to the exact Claude model
// the client specified. Skill routing is bypassed; effort is forwarded verbatim
// (haiku gets effort stripped by stripUnsupportedFieldsForModel). This path
// preserves the user's explicit model choice from the Claude Code model picker.
func (s *Server) handleNativeModel(
	w http.ResponseWriter, r *http.Request,
	cfg *config.RouterConfig, apCfg *config.AnthropicPassthroughConfig,
	body []byte, requestedModel string,
) {
	clientWants1M := requestRequestsContext1M(r.Header.Values("Anthropic-Beta"))
	use1M := clientWants1M && apCfg.ExtraUsageEnabled && len(body) > apCfg.EffectiveContext1MThresholdBytes()
	stripBeta := !use1M || strings.Contains(strings.ToLower(requestedModel), "haiku")

	// rewriteModelInBody is a no-op here (model already correct) but ensures the
	// body is re-serialised cleanly if Brick ever needs to normalise the field.
	rewritten := rewriteModelInBody(body, requestedModel)
	rewritten = stripUnsupportedFieldsForModel(rewritten, requestedModel)

	// Count native-model traffic under label="native" so status shows both paths.
	metrics.BrickCCRequests.WithLabelValues("native", requestedModel).Inc()

	logging.Infof("AnthropicPassthrough[native]: model=%s use_1m=%t upstream=%s bytes=%d",
		requestedModel, use1M, apCfg.EffectiveUpstreamURL(), len(rewritten))

	s.forwardAnthropicRequest(w, r, apCfg, rewritten, requestedModel, "native", "", false, stripBeta)
}

// forwardAnthropicRequest sends the (possibly rewritten) body to the Anthropic
// upstream and streams the response back to the client. It is shared by
// handleBrickRouted and handleNativeModel. effortStr, when non-empty, is the
// autonomously-computed reasoning effort and is surfaced as X-Brick-Effort.
func (s *Server) forwardAnthropicRequest(
	w http.ResponseWriter, r *http.Request,
	apCfg *config.AnthropicPassthroughConfig,
	body []byte,
	selectedModel, label, effortStr string,
	routedViaSkill bool,
	stripBeta bool,
) {
	upstreamURL := apCfg.EffectiveUpstreamURL() + "/v1/messages"
	upstreamReq, err := http.NewRequestWithContext(r.Context(), http.MethodPost, upstreamURL, bytes.NewReader(body))
	if err != nil {
		writeError(w, http.StatusInternalServerError, fmt.Sprintf("building upstream request: %v", err))
		return
	}
	for name, values := range r.Header {
		if _, hop := hopByHopHeaders[http.CanonicalHeaderKey(name)]; hop {
			continue
		}
		if http.CanonicalHeaderKey(name) == "Anthropic-Beta" && stripBeta {
			for _, v := range values {
				stripped := stripContext1MBeta(v)
				if stripped != "" {
					upstreamReq.Header.Add(name, stripped)
				}
			}
			continue
		}
		for _, v := range values {
			upstreamReq.Header.Add(name, v)
		}
	}
	upstreamReq.ContentLength = int64(len(body))

	resp, err := anthropicHTTPClient.Do(upstreamReq)
	if err != nil {
		logging.Errorf("AnthropicPassthrough: upstream call failed: %v", err)
		writeError(w, http.StatusBadGateway, fmt.Sprintf("upstream error: %v", err))
		return
	}
	defer resp.Body.Close()

	for name, values := range resp.Header {
		if _, hop := hopByHopHeaders[http.CanonicalHeaderKey(name)]; hop {
			continue
		}
		for _, v := range values {
			w.Header().Add(name, v)
		}
	}
	w.Header().Set("X-Brick-Selected-Model", selectedModel)
	w.Header().Set("X-Brick-Complexity", label)
	if effortStr != "" {
		w.Header().Set("X-Brick-Effort", effortStr)
	}
	if routedViaSkill {
		w.Header().Set("x-brick-route-reason", "skill_vector")
	} else {
		w.Header().Set("x-brick-route-reason", "model_map")
	}
	w.WriteHeader(resp.StatusCode)

	flusher, _ := w.(http.Flusher)
	buf := make([]byte, 32*1024)
	for {
		n, readErr := resp.Body.Read(buf)
		if n > 0 {
			if _, writeErr := w.Write(buf[:n]); writeErr != nil {
				logging.Warnf("AnthropicPassthrough: client write failed: %v", writeErr)
				return
			}
			if flusher != nil {
				flusher.Flush()
			}
		}
		if readErr == io.EOF {
			return
		}
		if readErr != nil {
			logging.Warnf("AnthropicPassthrough: upstream read failed: %v", readErr)
			return
		}
	}
}

func classifyAnthropicComplexity(ctx context.Context, cfg *config.RouterConfig, prompt string) string {
	baseURL, token, timeout := resolveComplexityEndpoint(cfg)
	body, _ := json.Marshal(map[string]string{"text": prompt})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, baseURL+"/classify", bytes.NewReader(body))
	if err != nil {
		logging.Warnf("AnthropicPassthrough: complexity fallback: %v", err)
		return "medium"
	}
	req.Header.Set("Content-Type", "application/json")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}

	client := &http.Client{Timeout: timeout}
	resp, err := client.Do(req)
	if err != nil {
		logging.Warnf("AnthropicPassthrough: complexity fallback: %v", err)
		return "medium"
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		logging.Warnf("AnthropicPassthrough: complexity fallback: status=%d", resp.StatusCode)
		return "medium"
	}

	var decoded struct {
		Label string `json:"label"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&decoded); err != nil {
		logging.Warnf("AnthropicPassthrough: complexity fallback: %v", err)
		return "medium"
	}
	label := strings.ToLower(strings.TrimSpace(decoded.Label))
	if label != "easy" && label != "medium" && label != "hard" {
		return "medium"
	}
	return label
}

func resolveComplexityEndpoint(cfg *config.RouterConfig) (string, string, time.Duration) {
	timeout := 5 * time.Second
	baseURL := ""
	token := ""
	if cfg != nil {
		if cfg.SkillRouter.ComplexityModel.TimeoutSeconds > 0 {
			timeout = time.Duration(cfg.SkillRouter.ComplexityModel.TimeoutSeconds) * time.Second
		}
		baseURL = strings.TrimRight(cfg.SkillRouter.ComplexityModel.BaseURL, "/")
		token = strings.TrimSpace(cfg.SkillRouter.ComplexityModel.BearerToken)
		if token == "" && cfg.SkillRouter.ComplexityModel.BearerTokenFile != "" {
			if resolved, err := os.ReadFile(cfg.SkillRouter.ComplexityModel.BearerTokenFile); err == nil {
				token = strings.TrimSpace(string(resolved))
			}
		}
		if cfg.ComplexityService != nil {
			if cfg.ComplexityService.TimeoutSeconds > 0 && cfg.SkillRouter.ComplexityModel.TimeoutSeconds == 0 {
				timeout = time.Duration(cfg.ComplexityService.TimeoutSeconds) * time.Second
			}
			if baseURL == "" {
				baseURL = strings.TrimRight(cfg.ComplexityService.BaseURL, "/")
				if baseURL == "" {
					addr := cfg.ComplexityService.Address
					if addr == "" {
						addr = "127.0.0.1"
					}
					port := cfg.ComplexityService.Port
					if port == 0 {
						port = 8094
					}
					baseURL = formatHTTPEndpoint(addr, port)
				}
			}
			if token == "" {
				if resolved, err := cfg.ComplexityService.ResolveBearerToken(); err == nil {
					token = resolved
				}
			}
		}
	}
	if baseURL == "" {
		baseURL = "http://127.0.0.1:8094"
	}
	return baseURL, token, timeout
}

// requestRequestsContext1M reports whether any incoming Anthropic-Beta header
// value contains a "context-1m-*" flag.
func requestRequestsContext1M(values []string) bool {
	for _, v := range values {
		for _, part := range strings.Split(v, ",") {
			if strings.HasPrefix(strings.TrimSpace(part), "context-1m-") {
				return true
			}
		}
	}
	return false
}

// stripContext1MBeta removes the "context-1m-*" beta flag from a comma-separated
// anthropic-beta header value. The 1M-token context window requires an extra-usage
// paid tier on Opus and is not supported at all on Sonnet/Haiku — forwarding it
// produces "Extra usage is required for 1M context" upstream errors when the
// router downgrades the model. Stripping it falls back to the standard 200K
// context window for all models.
func stripContext1MBeta(v string) string {
	parts := strings.Split(v, ",")
	kept := parts[:0]
	for _, p := range parts {
		t := strings.TrimSpace(p)
		if strings.HasPrefix(t, "context-1m-") {
			continue
		}
		kept = append(kept, t)
	}
	return strings.Join(kept, ",")
}

// extractAnthropicPromptText pulls the classification-relevant text from an
// Anthropic Messages API request body. It concatenates an optional system
// prompt with the text content of the most recent user message, supporting
// both string and structured (array of content blocks) shapes.
func extractAnthropicPromptText(body []byte) string {
	var raw struct {
		System   json.RawMessage `json:"system"`
		Messages []struct {
			Role    string          `json:"role"`
			Content json.RawMessage `json:"content"`
		} `json:"messages"`
	}
	if err := json.Unmarshal(body, &raw); err != nil {
		return ""
	}

	var parts []string
	if sys := decodeAnthropicContent(raw.System); sys != "" {
		parts = append(parts, sys)
	}
	for i := len(raw.Messages) - 1; i >= 0; i-- {
		if raw.Messages[i].Role != "user" {
			continue
		}
		if txt := decodeAnthropicContent(raw.Messages[i].Content); txt != "" {
			parts = append(parts, txt)
			break
		}
	}
	return strings.TrimSpace(strings.Join(parts, "\n"))
}

// maxContextClassifyChars bounds the size of the context-aware classification
// input so the small complexity classifier stays fast. Validated empirically:
// a 16000-char trailing window adds roughly 47ms median classifier latency.
const maxContextClassifyChars = 16000

// extractAnthropicContextText is the context-aware variant of
// extractAnthropicPromptText. Instead of only the latest user message, it
// concatenates the system prompt with the text of the last k conversation
// turns (user and assistant) in chronological order, so the classifier reflects
// accumulated context rather than a single short follow-up. Only text blocks
// are considered (same as decodeAnthropicContent); turns with no text content
// (pure tool_use / tool_result) are skipped. The result is truncated to the
// trailing maxContextClassifyChars to bound latency. Falls back to the
// single-turn extraction when k <= 1.
func extractAnthropicContextText(body []byte, k int) string {
	if k <= 1 {
		return extractAnthropicPromptText(body)
	}
	var raw struct {
		System   json.RawMessage `json:"system"`
		Messages []struct {
			Role    string          `json:"role"`
			Content json.RawMessage `json:"content"`
		} `json:"messages"`
	}
	if err := json.Unmarshal(body, &raw); err != nil {
		return ""
	}

	// Walk backwards collecting up to k turns with non-empty text.
	var turns []string
	for i := len(raw.Messages) - 1; i >= 0 && len(turns) < k; i-- {
		txt := decodeAnthropicContent(raw.Messages[i].Content)
		if txt == "" {
			continue
		}
		turns = append(turns, raw.Messages[i].Role+": "+txt)
	}
	// Reverse to chronological order.
	for l, r := 0, len(turns)-1; l < r; l, r = l+1, r-1 {
		turns[l], turns[r] = turns[r], turns[l]
	}

	var parts []string
	if sys := decodeAnthropicContent(raw.System); sys != "" {
		parts = append(parts, sys)
	}
	parts = append(parts, turns...)
	out := strings.TrimSpace(strings.Join(parts, "\n"))
	if r := []rune(out); len(r) > maxContextClassifyChars {
		out = string(r[len(r)-maxContextClassifyChars:])
	}
	return out
}

// decodeAnthropicContent handles the polymorphic Anthropic content field:
// either a JSON string, or an array of content blocks (only "text" blocks are
// extracted; tool_use / image / etc. are ignored for classification purposes).
func decodeAnthropicContent(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var s string
	if err := json.Unmarshal(raw, &s); err == nil {
		return s
	}
	var blocks []struct {
		Type string `json:"type"`
		Text string `json:"text"`
	}
	if err := json.Unmarshal(raw, &blocks); err != nil {
		return ""
	}
	var texts []string
	for _, b := range blocks {
		if b.Type == "text" && b.Text != "" {
			texts = append(texts, b.Text)
		}
	}
	return strings.Join(texts, "\n")
}

// modelSupportsEffort reports whether the target Anthropic model accepts the
// extended-thinking parameters Claude Code injects (`effort`, `thinking`,
// `reasoning_effort`). Haiku 4.x rejects them with HTTP 400; sonnet/opus accept.
func modelSupportsEffort(model string) bool {
	m := strings.ToLower(model)
	if strings.Contains(m, "haiku") {
		return false
	}
	return true
}

// stripUnsupportedFieldsForModel removes payload fields the target model does
// not accept. When the router downgrades to Haiku, Claude Code's request still
// carries effort/thinking controls that Haiku 4.x rejects with HTTP 400
// ("This model does not support the effort parameter.").
//
// The effort knob is nested: Claude Code sends `output_config.effort`
// (e.g. "xhigh"), not a top-level `effort`. We strip both the nested form and
// the legacy top-level forms, plus a top-level `thinking` block, then drop an
// emptied `output_config` so we never forward `"output_config": {}`.
// Returns the original bytes on JSON-parse failure.
func stripUnsupportedFieldsForModel(body []byte, model string) []byte {
	if modelSupportsEffort(model) {
		return body
	}
	var raw map[string]interface{}
	if err := json.Unmarshal(body, &raw); err != nil {
		return body
	}
	changed := false

	// Legacy / top-level forms some clients send.
	for _, k := range []string{"effort", "reasoning_effort", "thinking"} {
		if _, ok := raw[k]; ok {
			delete(raw, k)
			changed = true
		}
	}

	// Claude Code's actual location: output_config.effort.
	if oc, ok := raw["output_config"].(map[string]interface{}); ok {
		for _, k := range []string{"effort", "task_budget"} {
			if _, has := oc[k]; has {
				delete(oc, k)
				changed = true
			}
		}
		if len(oc) == 0 {
			delete(raw, "output_config")
		} else {
			raw["output_config"] = oc
		}
	}

	// context_management.edits may contain clear_thinking_20251015 entries which
	// require thinking to be enabled. Strip those edits when the model does not
	// support thinking (e.g. Haiku), or drop the entire context_management block
	// if no edits remain.
	if cm, ok := raw["context_management"].(map[string]interface{}); ok {
		if edits, ok := cm["edits"].([]interface{}); ok {
			var kept []interface{}
			for _, e := range edits {
				entry, _ := e.(map[string]interface{})
				if entry == nil {
					kept = append(kept, e)
					continue
				}
				t, _ := entry["type"].(string)
				if t == "clear_thinking_20251015" {
					changed = true
					continue
				}
				kept = append(kept, e)
			}
			if len(kept) == 0 {
				delete(cm, "edits")
			} else {
				cm["edits"] = kept
			}
		}
		if len(cm) == 0 {
			delete(raw, "context_management")
		} else {
			raw["context_management"] = cm
		}
	}

	if !changed {
		return body
	}
	out, err := json.Marshal(raw)
	if err != nil {
		return body
	}
	return out
}
