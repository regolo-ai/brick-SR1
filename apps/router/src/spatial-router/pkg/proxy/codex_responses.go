package proxy

import (
	"bytes"
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/regolo-ai/brick-SR1/apps/router/src/spatial-router/pkg/brickrouting"
	"github.com/regolo-ai/brick-SR1/apps/router/src/spatial-router/pkg/codextransport"
	"github.com/regolo-ai/brick-SR1/apps/router/src/spatial-router/pkg/config"
	"github.com/regolo-ai/brick-SR1/apps/router/src/spatial-router/pkg/observability/logging"
	"github.com/regolo-ai/brick-SR1/apps/router/src/spatial-router/pkg/observability/metrics"
)

// statusWriter preserves streaming while exposing the final HTTP status to the
// durable call-history recorder.
type statusWriter struct {
	http.ResponseWriter
	status                    int
	usageBuffer               bytes.Buffer
	inputTokens, outputTokens *int64
	cachedTokens              int64
}

func (w *statusWriter) WriteHeader(code int) {
	if w.status == 0 {
		w.status = code
	}
	w.ResponseWriter.WriteHeader(code)
}
func (w *statusWriter) Write(p []byte) (int, error) {
	if w.status == 0 {
		w.WriteHeader(http.StatusOK)
	}
	n, err := w.ResponseWriter.Write(p)
	if strings.Contains(w.Header().Get("Content-Type"), "text/event-stream") {
		for _, chunk := range bytes.SplitAfter(p[:n], []byte("\n")) {
			if w.usageBuffer.Len()+len(chunk) > 4*1024*1024 {
				w.usageBuffer.Reset()
				continue
			}
			w.usageBuffer.Write(chunk)
			if bytes.HasSuffix(chunk, []byte("\n")) {
				line := bytes.TrimSpace(w.usageBuffer.Bytes())
				if bytes.HasPrefix(line, []byte("data:")) {
					w.observeUsage(bytes.TrimSpace(bytes.TrimPrefix(line, []byte("data:"))))
				}
				w.usageBuffer.Reset()
			}
		}
	} else if w.usageBuffer.Len()+n <= 4*1024*1024 {
		w.usageBuffer.Write(p[:n])
	}
	return n, err
}
func (w *statusWriter) Flush() {
	if f, ok := w.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

// observeUsage reads either a complete Responses object or its final SSE event.
func (w *statusWriter) observeUsage(payload []byte) {
	var envelope struct {
		Usage    json.RawMessage `json:"usage"`
		Response struct {
			Usage json.RawMessage `json:"usage"`
		} `json:"response"`
	}
	if json.Unmarshal(payload, &envelope) != nil {
		return
	}
	raw := envelope.Usage
	if len(raw) == 0 {
		raw = envelope.Response.Usage
	}
	var usage struct {
		Input        *int64 `json:"input_tokens"`
		Output       *int64 `json:"output_tokens"`
		InputDetails struct {
			Cached int64 `json:"cached_tokens"`
		} `json:"input_tokens_details"`
	}
	if json.Unmarshal(raw, &usage) != nil {
		return
	}
	if usage.Input != nil {
		value := max(0, *usage.Input)
		w.inputTokens = &value
		w.cachedTokens = max(0, min(value, usage.InputDetails.Cached))
	}
	if usage.Output != nil {
		value := max(0, *usage.Output)
		w.outputTokens = &value
	}
}

func (s *Server) handleCodexResponses(w http.ResponseWriter, r *http.Request) {
	acceptedAt := time.Now().UTC()
	if r.Method != http.MethodPost {
		writeError(w, 405, "method not allowed")
		return
	}
	key, err := config.ResolveCredentialEnv(s.cfg.CodexRouter.LocalKeyEnv)
	if err != nil {
		writeError(w, 503, "Brick local authentication is not configured")
		return
	}
	if subtle.ConstantTimeCompare([]byte(r.Header.Get("X-Brick-Key")), []byte(key)) != 1 {
		writeError(w, 403, "invalid Brick local key")
		return
	}
	if encoding := r.Header.Get("Content-Encoding"); encoding != "" && encoding != "identity" {
		writeError(w, 415, "request compression has not been verified; disable compression in the Codex provider")
		return
	}
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxRequestBodySize))
	if err != nil {
		writeError(w, 413, "request body exceeds limit")
		return
	}
	defer r.Body.Close()
	var raw map[string]json.RawMessage
	if json.Unmarshal(body, &raw) != nil || raw == nil {
		writeError(w, 400, "invalid Responses request")
		return
	}
	var model string
	if json.Unmarshal(raw["model"], &model) != nil || model == "" {
		writeError(w, 400, "model is required")
		return
	}
	timeout := s.cfg.CodexRouter.TimeoutSeconds
	if timeout <= 0 {
		timeout = 600
	}
	ctx, cancel := context.WithTimeout(r.Context(), time.Duration(timeout)*time.Second)
	defer cancel()
	r = r.WithContext(ctx)
	operation := "responses"
	if strings.HasSuffix(r.URL.Path, "/compact") {
		operation = "compact"
	}
	destinations := map[string]config.CodexDestination{}
	allow := map[string]bool{}
	exclusions := []string{}
	if model == "brick" && !s.cfg.Brick.ModelRoutingEnabled() {
		model = s.cfg.Brick.EffectiveFixedModel(s.cfg.DefaultModel)
		raw["model"], _ = json.Marshal(model)
		body, _ = json.Marshal(raw)
	}
	candidates := []string{model}
	if model == "brick" {
		candidates = nil
		for _, m := range s.cfg.SkillRouter.Models {
			active := len(s.cfg.SkillRouter.ActiveModels) == 0
			for _, id := range s.cfg.SkillRouter.ActiveModels {
				if id == m.Model {
					active = true
				}
			}
			if active {
				candidates = append(candidates, m.Model)
			}
		}
	}
	for _, candidate := range candidates {
		d, resolveErr := s.cfg.ResolveCodexDestination(candidate, operation)
		if resolveErr != nil {
			if model == "brick" && errors.Is(resolveErr, config.ErrCodexUnsupported) {
				exclusions = append(exclusions, candidate+": "+resolveErr.Error())
				continue
			}
			writeError(w, 400, resolveErr.Error())
			return
		}
		capabilities := append([]string(nil), d.Capabilities...)
		if d.Protocol == "chat_completions" {
			capabilities = append(capabilities, "custom_tools", "opaque_reasoning", "item:additional_tools", "item:namespace")
		}
		compatibilityErr := codextransport.Compatible(body, capabilities)
		if d.Protocol == "chat_completions" && compatibilityErr == nil {
			_, compatibilityErr = codextransport.PrepareChat(body)
		}
		if model == "brick" {
			window := s.cfg.ModelConfig[candidate].ContextWindowSize
			if window <= 0 {
				compatibilityErr = fmt.Errorf("context_window_size is not configured")
			} else if estimatedCodexInputTokens(body) > window {
				compatibilityErr = fmt.Errorf("estimated input exceeds context_window_size %d", window)
			}
		}
		if err := compatibilityErr; err != nil {
			if model != "brick" {
				writeError(w, 400, err.Error())
				return
			}
			exclusions = append(exclusions, candidate+": "+err.Error())
			continue
		}
		destinations[candidate], allow[candidate] = d, true
	}
	if len(allow) == 0 {
		logging.Infof("Codex routing rejected all candidates: %s", strings.Join(exclusions, "; "))
		writeError(w, 400, "no compatible backend for this Responses request: "+strings.Join(exclusions, "; "))
		return
	}
	requested := ""
	var reasoning map[string]json.RawMessage
	_ = json.Unmarshal(raw["reasoning"], &reasoning)
	_ = json.Unmarshal(reasoning["effort"], &requested)
	selectedEffort := requested
	var route *brickrouting.Result
	if model == "brick" {
		router, err := s.getBrickRouter(s.cfg)
		if err != nil {
			writeError(w, 503, "Codex routing is unavailable")
			return
		}
		route, err = router.RouteWithOptions(r.Context(), codextransport.RoutingText(body, codexRoutingWindow(s.cfg)), requestRoutingOptions(body, allow))
		if err != nil {
			writeError(w, 502, "Codex routing failed")
			return
		}
		model = route.Model
		if !allow[model] {
			writeError(w, 502, "router selected an incompatible backend")
			return
		}
		raw["model"], _ = json.Marshal(destinations[model].UpstreamModel)
		body, _ = json.Marshal(raw)
	}
	d := destinations[model]
	if d.UpstreamModel != model && string(raw["model"]) != `"brick"` {
		raw["model"], _ = json.Marshal(d.UpstreamModel)
		body, _ = json.Marshal(raw)
	}
	upstreamKey := ""
	if d.AuthSource == "codex_request" {
		auth := r.Header.Get("Authorization")
		if !strings.HasPrefix(auth, "Bearer ") {
			writeError(w, 401, "Codex authentication is required")
			return
		}
		upstreamKey, err = config.ValidateCredential(strings.TrimPrefix(auth, "Bearer "))
	} else {
		upstreamKey, err = config.ResolveCredentialEnv(d.APIKeyEnv)
	}
	if err != nil {
		writeError(w, 502, "credential unavailable for provider "+d.Provider)
		return
	}
	body = adaptClientReasoning(body, s.cfg, model)
	selectedEffort = requestEffort(body)
	w.Header().Set("X-Brick-Selected-Model", model)
	w.Header().Set("X-Brick-Reasoning-Requested", requested)
	w.Header().Set("X-Brick-Reasoning-Selected", selectedEffort)
	w.Header().Set("X-Brick-Reasoning-Sent", selectedEffort)
	logging.Infof("Codex routing selected model=%s provider=%s protocol=%s reasoning_requested=%s reasoning_selected=%s reasoning_sent=%s exclusions=%q", model, d.Provider, d.Protocol, requested, selectedEffort, selectedEffort, exclusions)
	if d.Protocol == "chat_completions" {
		adapted, err := codextransport.PrepareChat(body)
		if err != nil {
			writeError(w, 400, err.Error())
			return
		}
		recordCodexForward(route, model)
		s.forwardCodexWithHistory(w, r, acceptedAt, model, selectedEffort, route != nil, route, func(sw http.ResponseWriter) {
			codextransport.ForwardChat(sw, r, &http.Client{}, d.URL, d.Provider, upstreamKey, adapted)
		})
		return
	}
	recordCodexForward(route, model)
	s.forwardCodexWithHistory(w, r, acceptedAt, model, selectedEffort, route != nil, route, func(sw http.ResponseWriter) {
		codextransport.Forward(sw, r, &http.Client{}, d.URL, d.Provider, upstreamKey, d.AuthSource == "codex_request", body)
	})
}

func (s *Server) forwardCodexWithHistory(w http.ResponseWriter, r *http.Request, started time.Time, model, effort string, routed bool, route *brickrouting.Result, forward func(http.ResponseWriter)) {
	providerStarted := time.Now()
	sw := &statusWriter{ResponseWriter: w}
	forward(sw)
	if !strings.Contains(sw.Header().Get("Content-Type"), "text/event-stream") {
		sw.observeUsage(sw.usageBuffer.Bytes())
	}
	var input, output int64
	if sw.inputTokens != nil {
		input = *sw.inputTokens
	}
	if sw.outputTokens != nil {
		output = *sw.outputTokens
	}
	cached := sw.cachedTokens
	if cached < 0 {
		cached = 0
	}
	if cached > input {
		cached = input
	}
	s.recordEconomicsUsage(model, input-cached, 0, cached, output)
	if s.callHistory == nil {
		return
	}
	status := "completed"
	var cause error
	if sw.status < 200 || sw.status >= 300 {
		status = "failed"
		cause = fmt.Errorf("upstream returned status %d", sw.status)
	}
	source := "native"
	if routed {
		source = "routed"
	}
	finished := time.Now().UTC()
	providerMS, overallMS := time.Since(providerStarted).Milliseconds(), finished.Sub(started).Milliseconds()
	record := callRecord{CallID: newBrickCallID(), StartedAt: started, FinishedAt: finished, Model: model, ReasoningMode: effort, RoutingSource: source, Status: status, Error: sanitizeCallError(cause), ProviderLatencyMS: &providerMS, OverallLatencyMS: &overallMS, InputTokens: sw.inputTokens, OutputTokens: sw.outputTokens}
	if route != nil {
		routingMS := providerStarted.Sub(started).Milliseconds()
		record.RoutingLatencyMS = &routingMS
	}
	applyRouteObservation(&record, route)
	if err := s.callHistory.append(record); err != nil {
		logging.Warnf("Call history: append failed: %v", err)
	}
}

func recordCodexForward(route *brickrouting.Result, model string) {
	source := "native"
	if route != nil {
		source = "routed"
	}
	metrics.BrickRequests.WithLabelValues(source, model).Inc()
}

func estimatedCodexInputTokens(body []byte) int {
	// This conservative preflight protects configured model limits without
	// rewriting the original request. Providers remain authoritative for exact
	// tokenizer accounting.
	// Responses payloads contain JSON schemas and escaped tool descriptions;
	// Codex's observed payload/token ratio is substantially higher than prose.
	// This preflight is a lower-bound guard, while the selected provider remains
	// authoritative for exact tokenizer enforcement.
	return (len([]rune(string(body))) + 7) / 8
}

func codexRoutingWindow(cfg *config.RouterConfig) int {
	if cfg.Brick.ContextWindow.Enabled {
		return cfg.Brick.EffectiveContextWindowK()
	}
	return 0
}
