package proxy

import (
	"context"
	"encoding/json"
	"net/http"
	"time"

	"github.com/regolo-ai/brick-SR1/apps/router/src/spatial-router/pkg/observability/logging"
)

// handleDiagClassifier reports whether the configured complexity classifier
// is reachable and what device it loaded the model on. Used by `brick claude
// status` to surface "the GPU is actually being hit" without requiring the
// caller to know the bearer token. Returns:
//
//	{"reachable": true, "device": "cuda", "latency_ms": 12, "endpoint": "..."}
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

	healthURL := endpoint + "/health"

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

	client := &http.Client{Timeout: 3 * time.Second}
	start := time.Now()
	resp, err := client.Do(req)
	latencyMs := time.Since(start).Milliseconds()
	if err != nil {
		logging.Warnf("[DiagClassifier] /health failed: %v", err)
		writeJSON(w, http.StatusOK, map[string]any{
			"enabled":   true,
			"endpoint":  endpoint,
			"reachable": false,
			"error":     err.Error(),
		})
		return
	}
	defer resp.Body.Close()

	var health struct {
		Status string `json:"status"`
		Model  string `json:"model"`
		Device string `json:"device"`
	}
	_ = json.NewDecoder(resp.Body).Decode(&health)

	writeJSON(w, http.StatusOK, map[string]any{
		"enabled":     true,
		"endpoint":    endpoint,
		"reachable":   resp.StatusCode == http.StatusOK,
		"http_status": resp.StatusCode,
		"latency_ms":  latencyMs,
		"device":      health.Device,
		"model":       health.Model,
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
