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
// verbatim to the configured upstream — only the `model` field is rewritten
// based on the difficulty classification of the prompt.
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

	prompt := extractAnthropicPromptText(body)
	if prompt == "" {
		logging.Warnf("AnthropicPassthrough: could not extract prompt text, falling back to medium")
	}

	label := "medium"
	if prompt != "" {
		label = classifyAnthropicComplexity(r.Context(), cfg, prompt)
	}

	clientWants1M := requestRequestsContext1M(r.Header.Values("Anthropic-Beta"))
	use1M := clientWants1M && apCfg.ExtraUsageEnabled && len(body) > apCfg.EffectiveContext1MThresholdBytes()

	var selectedModel string
	if use1M {
		selectedModel = apCfg.Resolve1M(label)
	} else {
		selectedModel = apCfg.Resolve(label)
	}

	metrics.BrickCCRequests.WithLabelValues(label, selectedModel).Inc()

	rewritten := rewriteModelInBody(body, selectedModel)
	rewritten = stripUnsupportedFieldsForModel(rewritten, selectedModel)

	upstreamURL := apCfg.EffectiveUpstreamURL() + "/v1/messages"
	upstreamReq, err := http.NewRequestWithContext(r.Context(), http.MethodPost, upstreamURL, bytes.NewReader(rewritten))
	if err != nil {
		writeError(w, http.StatusInternalServerError, fmt.Sprintf("building upstream request: %v", err))
		return
	}
	for name, values := range r.Header {
		if _, hop := hopByHopHeaders[http.CanonicalHeaderKey(name)]; hop {
			continue
		}
		if http.CanonicalHeaderKey(name) == "Anthropic-Beta" && !use1M {
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
	upstreamReq.ContentLength = int64(len(rewritten))

	logging.Infof("AnthropicPassthrough: complexity=%s model=%s use_1m=%t client_1m=%t upstream=%s bytes=%d",
		label, selectedModel, use1M, clientWants1M, upstreamURL, len(rewritten))

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

	if !changed {
		return body
	}
	out, err := json.Marshal(raw)
	if err != nil {
		return body
	}
	return out
}
