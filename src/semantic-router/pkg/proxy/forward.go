package proxy

import (
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/vllm-project/semantic-router/src/semantic-router/pkg/observability/logging"
)

// forwardToBackend forwards the request to the selected backend and streams
// the response back to the client.
func (s *Server) forwardToBackend(w http.ResponseWriter, clientReq *http.Request, result *RoutingResult) {
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

	// Copy safe headers from original client request
	for _, safeHeader := range []string{"Accept", "Accept-Encoding", "User-Agent"} {
		if v := clientReq.Header.Get(safeHeader); v != "" {
			if upstreamReq.Header.Get(safeHeader) == "" {
				upstreamReq.Header.Set(safeHeader, v)
			}
		}
	}

	// Send upstream request
	client := &http.Client{
		Timeout: 5 * time.Minute, // LLM requests can be slow
	}
	upstreamResp, err := client.Do(upstreamReq)
	if err != nil {
		logging.Errorf("Upstream request failed: %v", err)
		writeError(w, http.StatusBadGateway, fmt.Sprintf("upstream request failed: %v", err))
		return
	}
	defer upstreamResp.Body.Close()

	logging.Infof("Upstream response: status=%d content-type=%s",
		upstreamResp.StatusCode, upstreamResp.Header.Get("Content-Type"))

	// Check if this is a streaming response
	contentType := upstreamResp.Header.Get("Content-Type")
	isSSE := strings.Contains(contentType, "text/event-stream")

	if isSSE {
		s.streamSSEResponse(w, upstreamResp)
	} else {
		s.forwardNonStreamingResponse(w, upstreamResp)
	}
}

// streamSSEResponse streams an SSE response from the backend to the client.
// This is critical for chat completions with stream=true.
func (s *Server) streamSSEResponse(w http.ResponseWriter, upstreamResp *http.Response) {
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

	// Stream data from upstream to client
	buf := make([]byte, 4096)
	for {
		n, err := upstreamResp.Body.Read(buf)
		if n > 0 {
			_, writeErr := w.Write(buf[:n])
			if writeErr != nil {
				logging.Errorf("Error writing SSE chunk to client: %v", writeErr)
				return
			}
			flusher.Flush()
		}
		if err != nil {
			if err != io.EOF {
				logging.Errorf("Error reading upstream SSE stream: %v", err)
			}
			return
		}
	}
}

// forwardNonStreamingResponse forwards a non-streaming response from the backend.
func (s *Server) forwardNonStreamingResponse(w http.ResponseWriter, upstreamResp *http.Response) {
	// Copy response headers
	for key, values := range upstreamResp.Header {
		for _, value := range values {
			w.Header().Add(key, value)
		}
	}

	w.WriteHeader(upstreamResp.StatusCode)

	// Copy response body
	if _, err := io.Copy(w, upstreamResp.Body); err != nil {
		logging.Errorf("Error copying upstream response body: %v", err)
	}
}
