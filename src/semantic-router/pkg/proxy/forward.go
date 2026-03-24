package proxy

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/vllm-project/semantic-router/src/semantic-router/pkg/observability/logging"
)

const (
	upstreamMaxRetries = 3
	upstreamRetryWait  = 5 * time.Second
)

// forwardToBackend forwards the request to the selected backend and streams
// the response back to the client. When maskModel is non-empty, the "model"
// field in the JSON response body is rewritten to hide the real backend model.
func (s *Server) forwardToBackend(w http.ResponseWriter, clientReq *http.Request, result *RoutingResult, maskModel ...string) {
	modelMask := ""
	if len(maskModel) > 0 {
		modelMask = maskModel[0]
	}
	// Build the upstream URL
	endpoint := result.ForwardEndpoint
	if !strings.HasPrefix(endpoint, "http") {
		endpoint = "http://" + endpoint
	}
	// Strip trailing slash from endpoint
	endpoint = strings.TrimRight(endpoint, "/")
	upstreamURL := endpoint + result.ForwardPath

	logging.Infof("Forwarding to backend: %s (streaming=%v, body_size=%d)",
		upstreamURL, result.IsStreaming, len(result.ForwardBody))

	// Create upstream request
	upstreamReq, err := http.NewRequestWithContext(
		clientReq.Context(),
		http.MethodPost,
		upstreamURL,
		strings.NewReader(string(result.ForwardBody)),
	)
	if err != nil {
		writeError(w, http.StatusBadGateway, fmt.Sprintf("failed to create upstream request: %v", err))
		return
	}

	// Set standard headers
	upstreamReq.Header.Set("Content-Type", "application/json")

	// Apply headers from routing pipeline
	for key, value := range result.ForwardHeaders {
		// Skip pseudo-headers (Envoy-specific)
		if strings.HasPrefix(key, ":") {
			continue
		}
		// Skip internal routing headers
		if strings.HasPrefix(key, "x-vsr-") || key == "x-selected-model" {
			continue
		}
		upstreamReq.Header.Set(key, value)
	}

	// Log auth header status for debugging credential propagation
	if auth := upstreamReq.Header.Get("Authorization"); auth != "" {
		prefix := auth
		if len(prefix) > 20 {
			prefix = prefix[:20] + "..."
		}
		logging.Infof("Forwarding with auth header: %s", prefix)
	} else {
		logging.Warnf("Forwarding WITHOUT auth header — upstream will likely reject")
	}

	// Copy safe headers from original client request
	for _, safeHeader := range []string{"Accept", "Accept-Encoding", "User-Agent"} {
		if v := clientReq.Header.Get(safeHeader); v != "" {
			if upstreamReq.Header.Get(safeHeader) == "" {
				upstreamReq.Header.Set(safeHeader, v)
			}
		}
	}

	// Send upstream request with retry on transient failures.
	client := &http.Client{
		Timeout: 10 * time.Minute, // LLM reasoning requests can be very slow
	}

	var upstreamResp *http.Response
	var lastErr error
	for attempt := 1; attempt <= upstreamMaxRetries; attempt++ {
		// Recreate the request body reader for each attempt.
		upstreamReq.Body = io.NopCloser(strings.NewReader(string(result.ForwardBody)))

		upstreamResp, lastErr = client.Do(upstreamReq)
		if lastErr == nil {
			// Got a response — check for retryable HTTP status codes.
			if upstreamResp.StatusCode == http.StatusServiceUnavailable ||
				upstreamResp.StatusCode == http.StatusGatewayTimeout ||
				upstreamResp.StatusCode == http.StatusTooManyRequests {
				upstreamResp.Body.Close()
				lastErr = fmt.Errorf("upstream returned status %d", upstreamResp.StatusCode)
				upstreamResp = nil
			} else {
				break // success
			}
		} else if errors.Is(lastErr, context.Canceled) {
			// Client disconnected — no point retrying.
			logging.Warnf("Client cancelled request, aborting upstream forward")
			writeError(w, http.StatusBadGateway, "client cancelled request")
			return
		}

		if attempt < upstreamMaxRetries {
			logging.Warnf("Upstream attempt %d/%d failed: %v — retrying in %v",
				attempt, upstreamMaxRetries, lastErr, upstreamRetryWait)
			time.Sleep(upstreamRetryWait)
		}
	}

	if lastErr != nil {
		logging.Errorf("Upstream request failed after %d attempts: %v", upstreamMaxRetries, lastErr)
		writeError(w, http.StatusBadGateway, fmt.Sprintf("upstream request failed after %d attempts: %v", upstreamMaxRetries, lastErr))
		return
	}
	defer upstreamResp.Body.Close()

	logging.Infof("Upstream response: status=%d content-type=%s",
		upstreamResp.StatusCode, upstreamResp.Header.Get("Content-Type"))

	// Check if this is a streaming response
	contentType := upstreamResp.Header.Get("Content-Type")
	isSSE := strings.Contains(contentType, "text/event-stream")

	if isSSE {
		s.streamSSEResponse(w, upstreamResp, modelMask)
	} else {
		s.forwardNonStreamingResponse(w, upstreamResp, modelMask)
	}
}

// streamSSEResponse streams an SSE response from the backend to the client.
// This is critical for chat completions with stream=true.
// When maskModel is non-empty, the "model" field in each SSE data chunk is
// rewritten to hide the real backend model name.
func (s *Server) streamSSEResponse(w http.ResponseWriter, upstreamResp *http.Response, maskModel string) {
	// Set SSE headers
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("Transfer-Encoding", "chunked")

	// Copy other safe response headers
	for _, h := range []string{"X-Request-Id", "Openai-Processing-Ms"} {
		if v := upstreamResp.Header.Get(h); v != "" {
			w.Header().Set(h, v)
		}
	}

	w.WriteHeader(upstreamResp.StatusCode)

	// Get flusher for streaming
	flusher, ok := w.(http.Flusher)
	if !ok {
		logging.Errorf("ResponseWriter does not support Flusher interface")
		return
	}

	// Stream SSE line-by-line so we can rewrite the model field in each chunk
	scanner := bufio.NewScanner(upstreamResp.Body)
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024) // allow up to 1MB lines
	for scanner.Scan() {
		line := scanner.Text()
		if maskModel != "" && strings.HasPrefix(line, "data: ") && line != "data: [DONE]" {
			payload := strings.TrimPrefix(line, "data: ")
			line = "data: " + string(rewriteModelInResponseBody([]byte(payload), maskModel))
		}
		fmt.Fprintf(w, "%s\n", line)
		flusher.Flush()
	}
	if err := scanner.Err(); err != nil {
		logging.Errorf("Error reading upstream SSE stream: %v", err)
	}
}

// forwardNonStreamingResponse forwards a non-streaming response from the backend.
// When maskModel is non-empty, the "model" field in the JSON response is rewritten.
func (s *Server) forwardNonStreamingResponse(w http.ResponseWriter, upstreamResp *http.Response, maskModel string) {
	// Copy response headers (except Content-Length, which may change after rewrite)
	for key, values := range upstreamResp.Header {
		if maskModel != "" && strings.EqualFold(key, "Content-Length") {
			continue
		}
		for _, value := range values {
			w.Header().Add(key, value)
		}
	}

	// Read full body so we can optionally rewrite the model field
	bodyBytes, err := io.ReadAll(upstreamResp.Body)
	if err != nil {
		logging.Errorf("Error reading upstream response body: %v", err)
		w.WriteHeader(upstreamResp.StatusCode)
		return
	}

	if maskModel != "" {
		bodyBytes = rewriteModelInResponseBody(bodyBytes, maskModel)
	}

	w.WriteHeader(upstreamResp.StatusCode)
	if _, err := w.Write(bodyBytes); err != nil {
		logging.Errorf("Error writing response body to client: %v", err)
	}
}

// rewriteModelInResponseBody replaces the "model" field in a JSON body with newModel.
// Returns the original body unchanged if parsing fails or no "model" field exists.
func rewriteModelInResponseBody(body []byte, newModel string) []byte {
	var raw map[string]interface{}
	if err := json.Unmarshal(body, &raw); err != nil {
		return body
	}
	if _, ok := raw["model"]; ok {
		raw["model"] = newModel
		if rewritten, err := json.Marshal(raw); err == nil {
			return rewritten
		}
	}
	return body
}
