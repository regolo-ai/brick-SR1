package proxy

import (
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
	status int
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
	return w.ResponseWriter.Write(p)
}
func (w *statusWriter) Flush() {
	if f, ok := w.ResponseWriter.(http.Flusher); ok {
		f.Flush()
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
	requestedModel := model
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
		route, err = router.RouteWithCandidates(r.Context(), codextransport.RoutingText(body, codexRoutingWindow(s.cfg)), intersectAllow(allow, brickFixedModelAllow(s.cfg)))
		if err != nil {
			writeError(w, 502, "Codex routing failed")
			return
		}
		model = route.Model
		if !allow[model] {
			writeError(w, 502, "router selected an incompatible backend")
			return
		}
		if s.cfg.SkillRouter.DynamicEffort {
			level := clampEffortLevelToAllowlist(autonomousEffortLevel(route.TauQuery, underCapacityForModel(route, model), routingPreferenceOf(s.cfg)), model, s.cfg)
			if level < 0 {
				selectedEffort = "none"
			} else {
				selectedEffort = vocabAt(brickEffortVocab, level)
			}
			if reasoning == nil {
				reasoning = map[string]json.RawMessage{}
			}
			reasoning["effort"], _ = json.Marshal(selectedEffort)
			raw["reasoning"], _ = json.Marshal(reasoning)
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
		recordCodexForward(s.cfg, requestedModel, route, model, selectedEffort)
		s.forwardCodexWithHistory(w, r, acceptedAt, model, selectedEffort, requestedModel == "brick", route, func(sw http.ResponseWriter) {
			codextransport.ForwardChat(sw, r, &http.Client{}, d.URL, d.Provider, upstreamKey, adapted)
		})
		return
	}
	recordCodexForward(s.cfg, requestedModel, route, model, selectedEffort)
	s.forwardCodexWithHistory(w, r, acceptedAt, model, selectedEffort, requestedModel == "brick", route, func(sw http.ResponseWriter) {
		codextransport.Forward(sw, r, &http.Client{}, d.URL, d.Provider, upstreamKey, d.AuthSource == "codex_request", body)
	})
}

func (s *Server) forwardCodexWithHistory(w http.ResponseWriter, r *http.Request, started time.Time, model, effort string, routed bool, route *brickrouting.Result, forward func(http.ResponseWriter)) {
	providerStarted := time.Now()
	sw := &statusWriter{ResponseWriter: w}
	forward(sw)
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
	mode := "off"
	if s.cfg != nil {
		mode = s.cfg.Brick.EffectiveRoutingMode()
	}
	finished := time.Now().UTC()
	providerMS, overallMS := time.Since(providerStarted).Milliseconds(), finished.Sub(started).Milliseconds()
	record := callRecord{CallID: newBrickCallID(), StartedAt: started, FinishedAt: finished, Model: model, ReasoningMode: effort, RoutingMode: mode, RoutingSource: source, Status: status, Error: sanitizeCallError(cause), ProviderLatencyMS: &providerMS, OverallLatencyMS: &overallMS}
	applyRouteObservation(&record, route)
	if err := s.callHistory.append(record); err != nil {
		logging.Warnf("Call history: append failed: %v", err)
	}
}

func recordCodexForward(cfg *config.RouterConfig, requestedModel string, route *brickrouting.Result, selectedModel, selectedEffort string) {
	if requestedModel == "brick" {
		recordBrickOpenAIRoute(cfg, route, selectedModel, selectedEffort)
		return
	}
	metrics.BrickCCRequests.WithLabelValues("native", selectedModel).Inc()
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
