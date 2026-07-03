package proxy

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"github.com/regolo-ai/brick-SR1/apps/router/src/spatial-router/pkg/observability/logging"
)

// handleDiagClassifier reports whether the configured complexity classifier
// is reachable and what device it loaded the model on. Used by `brick claude
// status` to surface "the classifier is actually being hit" without requiring
// the caller to know the bearer token. Returns:
//
//	{"reachable": true, "device": "cuda", "latency_ms": 12, "endpoint": "..."}
//
// The probe depends on the protocol. The brick protocol (local auto-spawned
// server) exposes an unauthenticated GET /health returning {status, model,
// device}. The openai protocol (a hosted OpenAI-compatible endpoint such as
// Regolo's brick-complexity-pro) has no /health and requires a bearer token,
// so we probe GET /v1/models with Authorization instead. Probing /health on
// an openai endpoint returns 403 and would wrongly report "unreachable" even
// when routing works.
func (s *Server) handleDiagClassifier(w http.ResponseWriter, r *http.Request) {
	cfg := s.cfg
	if cfg == nil || cfg.ComplexityService == nil || !cfg.ComplexityService.Enabled {
		writeJSON(w, http.StatusOK, map[string]any{
			"enabled": false,
		})
		return
	}

	endpoint := cfg.ComplexityService.BaseURL
	if endpoint == "" {
		addr := cfg.ComplexityService.Address
		if addr == "" {
			addr = "127.0.0.1"
		}
		port := cfg.ComplexityService.Port
		if port == 0 {
			port = 8093
		}
		endpoint = formatHTTPEndpoint(addr, port)
	}

	isOpenAI := strings.EqualFold(strings.TrimSpace(cfg.ComplexityService.Protocol), "openai")

	var healthURL string
	if isOpenAI {
		healthURL = strings.TrimRight(endpoint, "/") + "/v1/models"
	} else {
		healthURL = endpoint + "/health"
	}

	ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, healthURL, nil)
	if err != nil {
		writeJSON(w, http.StatusOK, map[string]any{
			"enabled":   true,
			"endpoint":  endpoint,
			"reachable": false,
			"error":     err.Error(),
		})
		return
	}

	// The openai probe hits an authenticated endpoint; the brick /health is open.
	if isOpenAI {
		if token, terr := cfg.ComplexityService.ResolveBearerToken(); terr == nil && token != "" {
			req.Header.Set("Authorization", "Bearer "+token)
		}
	}

	client := &http.Client{Timeout: 3 * time.Second}
	start := time.Now()
	resp, err := client.Do(req)
	latencyMs := time.Since(start).Milliseconds()
	if err != nil {
		logging.Warnf("[DiagClassifier] %s failed: %v", healthURL, err)
		writeJSON(w, http.StatusOK, map[string]any{
			"enabled":   true,
			"endpoint":  endpoint,
			"reachable": false,
			"error":     err.Error(),
		})
		return
	}
	defer resp.Body.Close()

	reachable := resp.StatusCode == http.StatusOK

	// The brick /health body carries {status, model, device}. An openai
	// /v1/models body is a model list with none of those fields, so report
	// the configured model and a "remote (openai)" device label instead.
	var device, model string
	if isOpenAI {
		device = "remote (openai)"
		model = cfg.ComplexityService.ModelName
	} else {
		var health struct {
			Status string `json:"status"`
			Model  string `json:"model"`
			Device string `json:"device"`
		}
		_ = json.NewDecoder(resp.Body).Decode(&health)
		device = health.Device
		model = health.Model
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"enabled":     true,
		"endpoint":    endpoint,
		"reachable":   reachable,
		"http_status": resp.StatusCode,
		"latency_ms":  latencyMs,
		"device":      device,
		"model":       model,
	})
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func formatHTTPEndpoint(addr string, port int) string {
	return "http://" + addr + ":" + intToStr(port)
}

func intToStr(n int) string {
	// Avoid pulling strconv just for this; perf irrelevant on a diag handler.
	if n == 0 {
		return "0"
	}
	neg := n < 0
	if neg {
		n = -n
	}
	var buf [20]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	if neg {
		i--
		buf[i] = '-'
	}
	return string(buf[i:])
}
