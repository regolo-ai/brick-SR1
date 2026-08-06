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

	"github.com/regolo-ai/brick-SR1/apps/router/src/spatial-router/pkg/observability/logging"
)

const (
	upstreamMaxRetries = 3
	upstreamRetryWait  = 5 * time.Second
)

// openAIUsage is the token usage envelope shared by OpenAI-compatible
// non-streaming responses and streaming SSE chunks. Only prompt/completion
// tokens are needed for economics tracking; other usage fields are ignored.
type openAIUsage struct {
	PromptTokens     int64 `json:"prompt_tokens"`
	CompletionTokens int64 `json:"completion_tokens"`
}

type openAIUsageEnvelope struct {
	Usage struct {
		PromptTokens     int64 `json:"prompt_tokens"`
		CompletionTokens int64 `json:"completion_tokens"`
		InputTokens      int64 `json:"input_tokens"`
		OutputTokens     int64 `json:"output_tokens"`
	} `json:"usage"`
	Response *struct {
		Usage struct {
			InputTokens  int64 `json:"input_tokens"`
			OutputTokens int64 `json:"output_tokens"`
		} `json:"usage"`
	} `json:"response"`
}

// extractOpenAIUsage accepts both Chat Completions usage and Responses usage.
// Streaming Responses place usage inside the response.completed event's
// nested response object.
func extractOpenAIUsage(payload []byte) openAIUsage {
	var env openAIUsageEnvelope
	if err := json.Unmarshal(payload, &env); err != nil {
		return openAIUsage{}
	}
	usage := openAIUsage{
		PromptTokens:     env.Usage.PromptTokens,
		CompletionTokens: env.Usage.CompletionTokens,
	}
	if usage.PromptTokens == 0 {
		usage.PromptTokens = env.Usage.InputTokens
	}
	if usage.CompletionTokens == 0 {
		usage.CompletionTokens = env.Usage.OutputTokens
	}
	if env.Response != nil {
		if usage.PromptTokens == 0 {
			usage.PromptTokens = env.Response.Usage.InputTokens
		}
		if usage.CompletionTokens == 0 {
			usage.CompletionTokens = env.Response.Usage.OutputTokens
		}
	}
	return usage
}

// injectStreamUsageOption ensures a streaming request body asks the
// OpenAI-compatible backend to emit a final usage-bearing SSE chunk. If the
// caller already set stream_options, it is left untouched. Non-JSON bodies
// are returned unchanged (best-effort — never blocks forwarding).
func injectStreamUsageOption(body []byte) []byte {
	var raw map[string]interface{}
	if err := json.Unmarshal(body, &raw); err != nil {
		return body // leave untouched if not valid JSON
	}
	if _, exists := raw["stream_options"]; exists {
		return body // caller already set it, don't override
	}
	raw["stream_options"] = map[string]bool{"include_usage": true}
	if rewritten, err := json.Marshal(raw); err == nil {
		return rewritten
	}
	return body
}

// recordEconomicsUsage records one request's token usage for model into the
// server's economics store, if both a store and a non-empty model are
// available. cacheCreationTokens/cacheReadTokens carry Anthropic prompt-cache
// counters (always 0 on the OpenAI-compatible path). Best-effort: never
// called when usage is entirely zero (an upstream response with no usage
// field parses to zero tokens). Shared by both the OpenAI-compatible (Regolo)
// and Anthropic passthrough forwarders.
func (s *Server) recordEconomicsUsage(model string, promptTokens, cacheCreationTokens, cacheReadTokens, completionTokens int64) {
	if s.economicsStore == nil || model == "" {
		return
	}
	if promptTokens == 0 && cacheCreationTokens == 0 && cacheReadTokens == 0 && completionTokens == 0 {
		return
	}
	s.economicsStore.RecordCachedUsage(model, promptTokens, cacheCreationTokens, cacheReadTokens, completionTokens)
}

// forwardToBackend forwards the request to the selected backend and streams
// the response back to the client. When maskModel is non-empty, the "model"
// field in the JSON response body is rewritten to hide the real backend model.
func (s *Server) forwardToBackend(w http.ResponseWriter, clientReq *http.Request, result *RoutingResult, maskModel ...string) {
	modelMask := ""
	if len(maskModel) > 0 {
		modelMask = maskModel[0]
	}
	// For streaming requests, ask the upstream to emit a final usage-bearing
	// SSE chunk so token counts can be tracked for economics purposes.
	if result.IsStreaming && !result.IsResponses {
		result.ForwardBody = injectStreamUsageOption(result.ForwardBody)
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

	// Never log any portion of credentials; this only records presence.
	if upstreamReq.Header.Get("Authorization") != "" {
		logging.Infof("Forwarding with Authorization header present")
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
		usage := s.streamSSEResponse(w, upstreamResp, modelMask, result.Model)
		s.recordOpenAIStickyResult(result, usage, upstreamResp.StatusCode)
	} else {
		usage := s.forwardNonStreamingResponse(w, upstreamResp, modelMask, result.Model)
		s.recordOpenAIStickyResult(result, usage, upstreamResp.StatusCode)
	}
}

// recordOpenAIStickyResult updates the cache-aware conversation state after a
// successful OpenAI-compatible response. OpenAI usage does not expose separate
// cache-read/write counters, so prompt_tokens is the best available estimate of
// the prefix that would need to be reprocessed after a model switch.
func (s *Server) recordOpenAIStickyResult(result *RoutingResult, usage openAIUsage, statusCode int) {
	if s.stickyStore == nil || result == nil || result.StickyKey == "" ||
		statusCode < http.StatusOK || statusCode >= http.StatusMultipleChoices {
		return
	}
	s.stickyStore.Record(
		result.StickyKey,
		result.Model,
		usage.PromptTokens,
		result.Compacted,
		time.Now(),
	)
}

// streamSSEResponse streams an SSE response from the backend to the client.
// This is critical for chat completions with stream=true.
// When maskModel is non-empty, the "model" field in each SSE data chunk is
// rewritten to hide the real backend model name. The model argument (the real
// selected model) is used only to attribute token usage to the economics
// store; it never alters what is streamed to the client.
func (s *Server) streamSSEResponse(w http.ResponseWriter, upstreamResp *http.Response, maskModel, model string) openAIUsage {
	// Set SSE headers
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("Transfer-Encoding", "chunked")

	// Copy other safe response headers
	for _, h := range []string{"X-Request-Id", "Openai-Processing-Ms", "X-Codex-Turn-State"} {
		if v := upstreamResp.Header.Get(h); v != "" {
			w.Header().Set(h, v)
		}
	}

	w.WriteHeader(upstreamResp.StatusCode)

	// Get flusher for streaming
	flusher, ok := w.(http.Flusher)
	if !ok {
		logging.Errorf("ResponseWriter does not support Flusher interface")
		return openAIUsage{}
	}

	// Track the last usage seen across chunks; some backends emit usage in a
	// dedicated final chunk, so the last non-zero usage wins.
	var lastUsage openAIUsage

	// Stream SSE line-by-line so we can rewrite the model field in each chunk
	scanner := bufio.NewScanner(upstreamResp.Body)
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024) // allow up to 1MB lines
	for scanner.Scan() {
		line := scanner.Text()
		if strings.HasPrefix(line, "data: ") && line != "data: [DONE]" {
			payload := strings.TrimPrefix(line, "data: ")
			// Observe usage as a side-channel without altering the streamed line.
			usage := extractOpenAIUsage([]byte(payload))
			if usage.PromptTokens != 0 || usage.CompletionTokens != 0 {
				lastUsage = usage
			}
			if maskModel != "" {
				line = "data: " + string(rewriteModelInResponseBody([]byte(payload), maskModel))
			}
		}
		fmt.Fprintf(w, "%s\n", line)
		flusher.Flush()
	}
	if err := scanner.Err(); err != nil {
		logging.Errorf("Error reading upstream SSE stream: %v", err)
	}

	s.recordEconomicsUsage(model, lastUsage.PromptTokens, 0, 0, lastUsage.CompletionTokens)
	return lastUsage
}

// forwardNonStreamingResponse forwards a non-streaming response from the backend.
// When maskModel is non-empty, the "model" field in the JSON response is rewritten.
// The model argument (the real selected model) is used only to attribute token
// usage to the economics store; it never alters the forwarded body.
func (s *Server) forwardNonStreamingResponse(w http.ResponseWriter, upstreamResp *http.Response, maskModel, model string) openAIUsage {
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
		return openAIUsage{}
	}

	// Observe usage as a side-channel before any rewriting; never blocks or
	// alters forwarding if the body has no usage field or isn't JSON.
	usage := extractOpenAIUsage(bodyBytes)
	s.recordEconomicsUsage(model, usage.PromptTokens, 0, 0, usage.CompletionTokens)

	if maskModel != "" {
		bodyBytes = rewriteModelInResponseBody(bodyBytes, maskModel)
	}

	w.WriteHeader(upstreamResp.StatusCode)
	if _, err := w.Write(bodyBytes); err != nil {
		logging.Errorf("Error writing response body to client: %v", err)
	}
	return usage
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
