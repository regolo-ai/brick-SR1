package proxy

import (
	"bytes"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
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

// anthropicUsage is the token-usage shape of the Anthropic Messages API. Both
// non-streaming responses (top-level "usage") and streaming events carry these
// fields. input_tokens covers ONLY the non-cached portion of the prompt; with
// prompt caching active the bulk of the context arrives as
// cache_read_input_tokens / cache_creation_input_tokens (this is why Claude
// Code's context meter can read 200k while input_tokens is ~1k), so all four
// counters are tracked for economics.
type anthropicUsage struct {
	InputTokens              int64 `json:"input_tokens"`
	CacheCreationInputTokens int64 `json:"cache_creation_input_tokens"`
	CacheReadInputTokens     int64 `json:"cache_read_input_tokens"`
	OutputTokens             int64 `json:"output_tokens"`
}

// anthropicNonStreamEnvelope is the minimal shape of a non-streaming
// /v1/messages response body, used to extract token usage.
type anthropicNonStreamEnvelope struct {
	Usage anthropicUsage `json:"usage"`
}

// anthropicStreamEvent is the minimal shape of a streaming SSE event payload.
// message_start carries usage.input_tokens (and a small initial output_tokens);
// message_delta carries the cumulative usage.output_tokens for the response.
// Both nest usage differently: message_start under "message.usage",
// message_delta under a top-level "usage".
type anthropicStreamEvent struct {
	Type    string `json:"type"`
	Message *struct {
		Usage anthropicUsage `json:"usage"`
	} `json:"message"`
	Usage *anthropicUsage `json:"usage"`
}

// handleAnthropicMessages implements a transparent pass-through for the
// Anthropic /v1/messages endpoint. The request body and headers (including
// Authorization, anthropic-version, anthropic-beta, User-Agent) are forwarded
// verbatim to the configured upstream.
//
// Model selection logic:
//   - If the client sends model="brick-claude" (or any "brick-*" prefix), Brick
//     runs the full skill router. The client's output_config.effort is mapped to
//     a per-request SystemOne knob, while preserving provider-supported effort.
//   - If the client sends a native Claude model (haiku/sonnet/opus), Brick
//     forwards the request verbatim to that model — no skill routing, no effort
//     override. This preserves the user's explicit model choice.
func (s *Server) handleAnthropicMessages(w http.ResponseWriter, r *http.Request) {
	clientKey, authErr := s.resolveClientAPIKey(r)
	if authErr != nil {
		writeError(w, http.StatusUnauthorized, authErr.Error())
		return
	}
	if clientKey == "" {
		clientKey, _ = config.ValidateCredential(r.Header.Get("x-api-key"))
	}
	r = r.WithContext(config.WithClientAPIKey(r.Context(), clientKey))
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

// anthropicRequestsImage reports whether an Anthropic Messages request carries
// at least one image content block.
func anthropicRequestsImage(body []byte) bool {
	var raw struct {
		Messages []struct {
			Content json.RawMessage `json:"content"`
		} `json:"messages"`
	}
	if json.Unmarshal(body, &raw) != nil {
		return false
	}
	for _, message := range raw.Messages {
		var blocks []struct {
			Type string `json:"type"`
		}
		if json.Unmarshal(message.Content, &blocks) != nil {
			continue
		}
		for _, block := range blocks {
			if block.Type == "image" {
				return true
			}
		}
	}
	return false
}

// anthropicImageAllow computes the candidate allowlist for image-bearing
// requests: only models that consume image input natively are eligible.
func anthropicImageAllow(cfg *config.RouterConfig, body []byte) (map[string]bool, bool) {
	if cfg == nil || !anthropicRequestsImage(body) {
		return nil, false
	}
	allow := map[string]bool{}
	for _, model := range cfg.SkillRouter.Models {
		if model.HandlesImages {
			allow[model.Model] = true
		}
	}
	return allow, true
}

// isNativeClaudeModel reports whether the requested model is an explicit Claude
// model name (e.g. "claude-haiku-4-5"). Used to decide whether subagent traffic
// that arrives with a concrete model should be pulled into the skill router when
// RouteSubagents is enabled.
func isNativeClaudeModel(model string) bool {
	return strings.Contains(strings.ToLower(model), "claude-")
}

// handleBrickRouted selects an eligible model using local SystemOne inference.
func (s *Server) handleBrickRouted(w http.ResponseWriter, r *http.Request, cfg *config.RouterConfig, apCfg *config.AnthropicPassthroughConfig, body []byte, clientEffort string) {
	started := time.Now().UTC()
	var route *brickrouting.Result
	var latency *int64
	selected := apCfg.EffectiveFixedModel()
	if apCfg.ModelRoutingEnabled() {
		router, err := s.getBrickRouter(cfg)
		if err != nil {
			writeError(w, 503, "SystemOne is unavailable")
			return
		}
		prompt := extractAnthropicPromptText(body)
		if apCfg.ContextWindow.Enabled {
			prompt = extractAnthropicContextText(body, apCfg.EffectiveContextWindowK())
		}
		if prompt == "" {
			prompt = "[multimodal request]"
		}
		allow, hasImage := anthropicImageAllow(cfg, body)
		if hasImage && len(allow) == 0 {
			writeError(w, http.StatusBadRequest, "no eligible model supports image input")
			return
		}
		options, optErr := requestRoutingOptions(r, body, allow)
		if optErr != nil {
			writeError(w, http.StatusBadRequest, optErr.Error())
			return
		}
		options.KeywordText = keywordText(extractAnthropicLastUserText(body))
		route, err = router.RouteWithOptions(r.Context(), prompt, options)
		if err != nil {
			writeRoutingError(w, err, "SystemOne routing failed")
			return
		}
		selected = route.Model
		elapsed := time.Since(started).Milliseconds()
		latency = &elapsed
	}
	use1M := requestRequestsContext1M(r.Header.Values("Anthropic-Beta")) && apCfg.ExtraUsageEnabled && len(body) > apCfg.EffectiveContext1MThresholdBytes()
	stripBeta := !use1M || strings.Contains(strings.ToLower(selected), "haiku")
	rewritten := stripUnsupportedFieldsForModel(rewriteModelInBody(body, selected), selected)
	knob := cfg.SkillRouter.Knob
	if route != nil {
		knob = route.Knob
	}
	rewritten = applyKnobEffort(rewritten, cfg, selected, knob)
	source := "native"
	if route != nil {
		source = "routed"
	}
	metrics.BrickRequests.WithLabelValues(source, selected).Inc()
	s.forwardAnthropicRequest(w, r, apCfg, rewritten, selected, requestEffort(rewritten), stripBeta, route, started, latency)
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
	rewritten = applyKnobEffort(rewritten, cfg, requestedModel, cfg.SkillRouter.Knob)

	// Count native-model traffic under label="native" so status shows both paths.
	metrics.BrickRequests.WithLabelValues("native", requestedModel).Inc()

	logging.Infof("AnthropicPassthrough[native]: model=%s use_1m=%t upstream=%s bytes=%d",
		requestedModel, use1M, apCfg.EffectiveUpstreamURL(), len(rewritten))

	s.forwardAnthropicRequest(w, r, apCfg, rewritten, requestedModel, extractClientEffort(body), stripBeta, nil, time.Now().UTC(), nil)
}

// forwardAnthropicRequest sends the (possibly rewritten) body to the Anthropic
// upstream and streams the response back to the client. It is shared by
// handleBrickRouted and handleNativeModel. effortStr, when non-empty, is the
// requestly-computed reasoning effort and is surfaced as X-Brick-Effort.
func (s *Server) forwardAnthropicRequest(w http.ResponseWriter, r *http.Request, apCfg *config.AnthropicPassthroughConfig, body []byte, selectedModel, effortStr string, stripBeta bool, route *brickrouting.Result, acceptedAt time.Time, routingLatency *int64) {
	// A skill-card entry with an explicit OpenAI-compatible base URL is a
	// provider-backed model (for example a Regolo model added to a Claude
	// profile). Anthropic's Messages payload cannot be forwarded verbatim to
	// that API, so translate the text request and non-streaming response here.
	// Native Claude models have no inline base_url and retain the transparent
	// Anthropic pass-through below.
	if modelCfg := findSkillRouterModel(s.cfg, selectedModel); modelCfg != nil && modelCfg.BaseURL != "" {
		s.forwardAnthropicToOpenAI(w, r, modelCfg, body, selectedModel, effortStr, route, acceptedAt, routingLatency)
		return
	}
	// start bounds Brick's end-to-end view of this request: upstream request
	// build, round-trip, and full response stream. Recorded into ev after the
	// stream completes; used only for observability, never for serving.
	start := time.Now()
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
		canonical := http.CanonicalHeaderKey(name)
		if canonical == http.CanonicalHeaderKey(KnobHeader) || canonical == "X-Brick-Key" {
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
	if effortStr != "" {
		w.Header().Set("X-Brick-Effort", effortStr)
	}
	if route != nil {
		w.Header().Set("x-brick-route-reason", routeReasonHeader(route))
	} else {
		w.Header().Set("x-brick-route-reason", "fixed")
	}
	w.WriteHeader(resp.StatusCode)

	contentType := resp.Header.Get("Content-Type")
	isSSE := strings.Contains(contentType, "text/event-stream")

	flusher, _ := w.(http.Flusher)
	buf := make([]byte, 32*1024)

	// Side-channel accumulators for usage observation. These NEVER influence
	// what is written to the client — every chunk read from upstream is
	// written to w unchanged, at the same cadence, before any accumulation
	// happens below. sseLineBuf holds an in-progress SSE line across reads;
	// nonStreamBuf accumulates the full non-streaming body (bounded, same
	// spirit as the OpenAI-compatible non-streaming path in forward.go,
	// which also buffers the whole response to extract usage).
	var sseLineBuf bytes.Buffer
	var nonStreamBuf bytes.Buffer
	var usage anthropicUsage
	const maxSideChannelBuf = 4 * 1024 * 1024 // defensive cap; parsing is best-effort

	for {
		n, readErr := resp.Body.Read(buf)
		if n > 0 {
			chunk := buf[:n]
			if _, writeErr := w.Write(chunk); writeErr != nil {
				logging.Warnf("AnthropicPassthrough: client write failed: %v", writeErr)
				return
			}
			if flusher != nil {
				flusher.Flush()
			}
			if isSSE {
				accumulateAnthropicSSEUsage(&sseLineBuf, chunk, maxSideChannelBuf, &usage)
			} else if nonStreamBuf.Len() < maxSideChannelBuf {
				nonStreamBuf.Write(chunk)
			}
		}
		if readErr == io.EOF {
			break
		}
		if readErr != nil {
			logging.Warnf("AnthropicPassthrough: upstream read failed: %v", readErr)
			break
		}
	}

	if !isSSE && nonStreamBuf.Len() > 0 {
		var env anthropicNonStreamEnvelope
		if jsonErr := json.Unmarshal(nonStreamBuf.Bytes(), &env); jsonErr == nil {
			usage = env.Usage
		}
	}
	s.recordEconomicsUsage(selectedModel, usage.InputTokens, usage.CacheCreationInputTokens, usage.CacheReadInputTokens, usage.OutputTokens)
	// Keep the dashboard independent from Prometheus: append one completed
	// privacy-preserving record only after the upstream body has supplied its
	// final usage (when available).
	if s.callHistory != nil {
		var in, out *int64
		if usage.InputTokens != 0 || usage.CacheCreationInputTokens != 0 || usage.CacheReadInputTokens != 0 || usage.OutputTokens != 0 {
			input := usage.InputTokens + usage.CacheCreationInputTokens + usage.CacheReadInputTokens
			output := usage.OutputTokens
			in, out = &input, &output
		}
		status := "completed"
		if resp.StatusCode < 200 || resp.StatusCode >= 300 {
			status = "failed"
		}
		source := "native"
		if route != nil {
			source = "routed"
		}
		finished := time.Now().UTC()
		latency := finished.Sub(start.UTC()).Milliseconds()
		overall := finished.Sub(acceptedAt).Milliseconds()
		record := callRecord{CallID: newBrickCallID(), StartedAt: acceptedAt, FinishedAt: finished, Model: selectedModel, ReasoningMode: effortStr, RoutingSource: source, Status: status, InputTokens: in, OutputTokens: out, ProviderLatencyMS: &latency, OverallLatencyMS: &overall, RoutingLatencyMS: routingLatency}
		applyRouteObservation(&record, route)
		if err := s.callHistory.append(record); err != nil {
			logging.Warnf("Call history: append failed: %v", err)
		}
	}

}

// accumulateAnthropicSSEUsage feeds a raw chunk of an Anthropic SSE stream
// into a rolling line buffer, extracting token usage from any complete
// "data: {...}" lines it finds (message_start.message.usage.input_tokens and
// message_delta.usage.output_tokens), and updates usage in place. The last
// non-zero value observed for each field wins. buf is capped at maxBuf bytes
// to bound memory on a malformed/never-terminated stream; parsing degrades
// silently (no usage recorded) rather than growing unbounded.
func accumulateAnthropicSSEUsage(buf *bytes.Buffer, chunk []byte, maxBuf int, usage *anthropicUsage) {
	if buf.Len()+len(chunk) > maxBuf {
		buf.Reset()
		return
	}
	buf.Write(chunk)
	for {
		line, err := buf.ReadString('\n')
		if err != nil {
			// No complete line yet: err carries io.EOF and line holds the
			// partial content already consumed from buf. Put it back for
			// the next chunk to complete.
			buf.Reset()
			buf.WriteString(line)
			return
		}
		trimmed := strings.TrimRight(line, "\r\n")
		if !strings.HasPrefix(trimmed, "data: ") {
			continue
		}
		payload := strings.TrimPrefix(trimmed, "data: ")
		if payload == "[DONE]" || payload == "" {
			continue
		}
		var ev anthropicStreamEvent
		if jsonErr := json.Unmarshal([]byte(payload), &ev); jsonErr != nil {
			continue
		}
		switch ev.Type {
		case "message_start":
			if ev.Message != nil {
				if ev.Message.Usage.InputTokens != 0 {
					usage.InputTokens = ev.Message.Usage.InputTokens
				}
				if ev.Message.Usage.CacheCreationInputTokens != 0 {
					usage.CacheCreationInputTokens = ev.Message.Usage.CacheCreationInputTokens
				}
				if ev.Message.Usage.CacheReadInputTokens != 0 {
					usage.CacheReadInputTokens = ev.Message.Usage.CacheReadInputTokens
				}
				if ev.Message.Usage.OutputTokens != 0 {
					usage.OutputTokens = ev.Message.Usage.OutputTokens
				}
			}
		case "message_delta":
			if ev.Usage != nil && ev.Usage.OutputTokens != 0 {
				usage.OutputTokens = ev.Usage.OutputTokens
			}
		}
	}
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
// extractAnthropicLastUserText returns only the latest user message, without
// the system prompt. Strict keyword rules use it so system instructions and
// assistant turns never force a model.
func extractAnthropicLastUserText(body []byte) string {
	var raw struct {
		Messages []struct {
			Role    string          `json:"role"`
			Content json.RawMessage `json:"content"`
		} `json:"messages"`
	}
	if err := json.Unmarshal(body, &raw); err != nil {
		return ""
	}
	for i := len(raw.Messages) - 1; i >= 0; i-- {
		if raw.Messages[i].Role != "user" {
			continue
		}
		return strings.TrimSpace(decodeAnthropicContent(raw.Messages[i].Content))
	}
	return ""
}

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

// extractAnthropicContextText is the context-aware variant of
// extractAnthropicPromptText. Instead of only the latest user message, it
// concatenates the system prompt with the text of the last k conversation
// turns (user and assistant) in chronological order, so the classifier reflects
// accumulated context rather than a single short follow-up. Only text blocks
// are considered (same as decodeAnthropicContent); turns with no text content
// (pure tool_use / tool_result) are skipped. The result is truncated to the
// checkpoint token limit inside the inference worker. Falls back to the
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
	if strings.Contains(strings.ToLower(model), "sonnet") {
		var raw map[string]interface{}
		if json.Unmarshal(body, &raw) == nil {
			if output, ok := raw["output_config"].(map[string]interface{}); ok && output["effort"] == "xhigh" {
				output["effort"] = "high"
				if encoded, err := json.Marshal(raw); err == nil {
					return encoded
				}
			}
		}
	}
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
