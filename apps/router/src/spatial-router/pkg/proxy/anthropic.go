package proxy

import (
	"bytes"
	"context"
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

	// Fallback complexity label for the model_map path. Only computed below when
	// the skill router does not run: the router returns its own complexity label,
	// so classifying here too would be a redundant round-trip. It also calls the
	// brick-protocol /classify endpoint, which a hosted openai classifier (Regolo)
	// rejects with 403 — harmless as a rare fallback, noisy on every request.
	label := "medium"

	clientWants1M := requestRequestsContext1M(r.Header.Values("Anthropic-Beta"))
	use1M := clientWants1M && apCfg.ExtraUsageEnabled && len(body) > apCfg.EffectiveContext1MThresholdBytes()

	// Model selection: full Brick skill router with per-request preference override.
	// tauQuery and under capture the autonomous-effort signals from the route.
	// The router runs even when model routing is disabled, because its signals
	// (query difficulty, model headroom) drive the autonomous thinking effort;
	// only its model *choice* is overridden by FixedModel further down.
	var selectedModel string
	var complexityLabel string
	var tauQuery, under float64
	var routeResult *brickrouting.Result
	routedViaSkill := false
	if apCfg.UseSkillRouter && cfg.SkillRouter.Enabled && prompt != "" {
		if router, rerr := s.getBrickRouter(cfg); rerr != nil {
			logging.Warnf("AnthropicPassthrough[brick]: skill router init failed, falling back to model_map: %v", rerr)
		} else if route, rerr := router.RouteWithPreference(r.Context(), prompt, preference); rerr != nil {
			logging.Warnf("AnthropicPassthrough[brick]: skill router failed, falling back to model_map: %v", rerr)
		} else {
			routeResult = route
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
	if !routedViaSkill && prompt != "" {
		// Model_map fallback only: the skill router did not produce a label.
		label = classifyAnthropicComplexity(r.Context(), cfg, prompt)
	}
	if selectedModel == "" {
		if use1M {
			selectedModel = apCfg.Resolve1M(label)
		} else {
			selectedModel = apCfg.Resolve(label)
		}
	}

	// Model-routing override: when model routing is disabled, pin every request
	// to the configured fixed model. The skill router's signals (tau, complexity)
	// are preserved so autonomous thinking effort still adapts per query; only the
	// model choice is replaced. Headroom is recomputed against the pinned model so
	// the effort bump reflects how stretched THIS model is, not the routed one.
	if !apCfg.ModelRoutingEnabled() {
		selectedModel = apCfg.EffectiveFixedModel()
		if routeResult != nil {
			under = underCapacityForModel(routeResult, selectedModel)
		}
	}

	// Cache-aware routing modes, layered on top of the calibrated router output
	// (the scoring core is never touched). "sticky" applies hysteresis;
	// "orchestrator" is a shadow-only path that logs intent without changing what
	// is served. An empty stickyKey means no post-response bookkeeping runs.
	//
	// candidateModel is the router's raw pick, captured before any cache-aware
	// post-processing can replace it, so the routing event log can record the
	// candidate-vs-served divergence a sticky hold produces.
	candidateModel := selectedModel
	stickyKey := ""
	switchDelta := 0.0
	compacted := false
	switch apCfg.EffectiveRoutingMode() {
	case config.RoutingModeSticky, config.RoutingModeSmartSqueeze:
		if routedViaSkill && apCfg.ModelRoutingEnabled() && routeResult != nil {
			stickyKey, selectedModel, under, switchDelta = s.applyStickyRouting(apCfg, body, routeResult, selectedModel, under)
		}
	case config.RoutingModeOrchestrator:
		if routedViaSkill && routeResult != nil {
			logShadowOrchestrator(len(body), routeResult, selectedModel)
		}
	}

	// Routing event (shadow observability): assembled here, where the mode,
	// candidate model, and conversation identity are known; the served model,
	// context size, and end-to-end latency are filled in after the response
	// streams. Written for every routed request regardless of mode so the
	// promotion-gate aggregator has an off/sticky/orchestrator baseline. It
	// never affects what is served.
	var ev *routingEvent
	if routedViaSkill && routeResult != nil {
		mode := apCfg.EffectiveRoutingMode()
		ev = &routingEvent{
			Mode:           mode,
			SessionKey:     anthropicSessionKey(body),
			CandidateModel: candidateModel,
			EstSwitchDelta: switchDelta,
		}
		if mode == config.RoutingModeOrchestrator {
			ev.ShadowNote = "shadow_only_not_served_extractor_pending"
		}
	}

	// Smartsqueeze compaction: on a switch the new provider's prompt cache is cold,
	// so shrink the forwarded context (clear old tool_result blocks) to cut the
	// prefix the new model reprocesses. No-op outside smartsqueeze mode, on a hold,
	// or in shadow sub-mode (where it only measures). See applySmartSqueeze.
	if apCfg.EffectiveRoutingMode() == config.RoutingModeSmartSqueeze {
		body, compacted = s.applySmartSqueeze(apCfg, body, stickyKey, selectedModel, ev)
	}

	metrics.BrickCCRequests.WithLabelValues(label, selectedModel).Inc()

	// Strip the 1M-context beta when the account lacks the extra-usage tier, OR
	// whenever the selected model has no 1M variant (Haiku) — forwarding it would
	// trigger an "Extra usage is required for 1M context" upstream error.
	stripBeta := !use1M || strings.Contains(strings.ToLower(selectedModel), "haiku")

	rewritten := rewriteModelInBody(body, selectedModel)
	effortStr := ""
	if routedViaSkill && cfg.SkillRouter.DynamicEffort && apCfg.ThinkingRoutingEnabled() {
		// Autonomous effort: query difficulty + chosen-model headroom, shifted by
		// the Brick mode bias (additive, preserves per-query granularity). Skipped
		// when thinking routing is disabled, so the client's own effort is forwarded
		// unchanged.
		level := autonomousEffortLevel(tauQuery, under, preference)
		// Enforce per-model allowlist: se il modello ha allowed_thinking_modes,
		// il livello calcolato viene clampato al valore consentito più vicino.
		// level == -1 è il sentinel per "off" (reasoning completamente disabilitato).
		level = clampEffortLevelToAllowlist(level, selectedModel, cfg)
		if level >= 0 {
			rewritten = applyEffortAnthropicLevel(rewritten, level, selectedModel)
			effortStr = vocabAt(claudeVocabForModel(selectedModel), level)
		} else {
			effortStr = "off"
		}
		metrics.BrickCCEffort.WithLabelValues(selectedModel, effortStr).Inc()
		metrics.BrickCCRouting.WithLabelValues(label, effortStr, selectedModel).Inc()
	}
	rewritten = stripUnsupportedFieldsForModel(rewritten, selectedModel)

	logging.Infof("AnthropicPassthrough[brick]: mode_effort=%s preference=%.2f complexity=%s tau=%.3f under=%.3f auto_effort=%s model=%s use_1m=%t bytes=%d",
		clientEffort, preference, label, tauQuery, under, effortStr, selectedModel, use1M, len(rewritten))

	s.forwardAnthropicRequest(w, r, apCfg, rewritten, selectedModel, label, effortStr, routedViaSkill, stripBeta, stickyKey, compacted, ev)
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

	s.forwardAnthropicRequest(w, r, apCfg, rewritten, requestedModel, "native", "", false, stripBeta, "", false, nil)
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
	stickyKey string,
	compacted bool,
	ev *routingEvent,
) {
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

	// Sticky routing bookkeeping: record the model actually served for this
	// conversation, keyed by response-arrival time so out-of-order concurrent
	// turns cannot overwrite fresher state (see pkg/sticky). The recorded
	// context size is the full prefix the next switch would have to reprocess:
	// fresh input + both cache tiers.
	if stickyKey != "" && s.stickyStore != nil {
		ctxTokens := usage.InputTokens + usage.CacheReadInputTokens + usage.CacheCreationInputTokens
		s.stickyStore.Record(stickyKey, selectedModel, ctxTokens, compacted, time.Now())
	}

	// Routing event: fill the post-response fields and append. Off the client's
	// critical path (the full response has already been streamed above). append
	// is a no-op when ev is nil (native path) or the log is disabled.
	if ev != nil {
		ev.ServedModel = selectedModel
		ev.CtxTokens = usage.InputTokens + usage.CacheReadInputTokens + usage.CacheCreationInputTokens
		// Break out the token components so the offline replay can price this turn
		// on both the served and the candidate model. InputTokens here is the fresh
		// (non-cached) input; the two cache tiers are billed at their multipliers.
		ev.FreshInputTokens = usage.InputTokens
		ev.CacheReadTokens = usage.CacheReadInputTokens
		ev.CacheCreationTokens = usage.CacheCreationInputTokens
		ev.OutputTokens = usage.OutputTokens
		ev.E2ELatencyMs = time.Since(start).Milliseconds()
		ev.TS = time.Now().UTC().Format(time.RFC3339Nano)
		s.routingEventLog.append(*ev)
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

// classifyAnthropicComplexity is the model_map fallback used only when the skill
// router did not produce a complexity label (skill router disabled, its init or
// route call failed, or the prompt was empty). It delegates to the same
// complexity classifier the skill router uses so it honours the configured
// protocol.
//
// Previously it unconditionally POSTed {base_url}/classify (the custom brick
// protocol), ignoring complexity_service.protocol / skill_router.complexity_model
// .protocol. With an OpenAI-compatible classifier (protocol: openai) that path
// hit /classify on an endpoint that only serves /v1/chat/completions, so every
// fallback request got a 403/404 and silently degraded to "medium".
func classifyAnthropicComplexity(ctx context.Context, cfg *config.RouterConfig, prompt string) string {
	return brickrouting.ClassifyComplexityLabel(ctx, cfg, prompt)
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

// extractAnthropicIdentityParts returns the two prompt components used to derive
// a stable conversation key for sticky routing: the system prompt and the text
// of the FIRST user turn. Both stay constant across turns of one conversation
// (unlike the last user turn), so their hash identifies the conversation.
// Empty when the body is unparseable or carries neither.
func extractAnthropicIdentityParts(body []byte) (system, firstUser string) {
	var raw struct {
		System   json.RawMessage `json:"system"`
		Messages []struct {
			Role    string          `json:"role"`
			Content json.RawMessage `json:"content"`
		} `json:"messages"`
	}
	if err := json.Unmarshal(body, &raw); err != nil {
		return "", ""
	}
	system = decodeAnthropicContent(raw.System)
	for i := range raw.Messages {
		if raw.Messages[i].Role != "user" {
			continue
		}
		if txt := decodeAnthropicContent(raw.Messages[i].Content); txt != "" {
			firstUser = txt
			break
		}
	}
	return system, firstUser
}

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
