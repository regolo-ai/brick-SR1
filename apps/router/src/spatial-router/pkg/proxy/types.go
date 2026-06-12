package proxy

import (
	"encoding/json"
	"net/http"
)

// maxRequestBodySize is the maximum allowed request body size (10 MB).
// Prevents OOM from oversized payloads sent by malicious or buggy clients.
const maxRequestBodySize = 10 << 20

// RoutingResult represents the outcome of running the routing pipeline.
type RoutingResult struct {
	// Direct means the pipeline produced a direct response (cache hit, error, block).
	// If true, StatusCode and Body are set; the proxy writes them directly to the client.
	Direct     bool
	StatusCode int
	Body       []byte
	Headers    map[string]string // response headers to set on direct responses

	// Forward means the pipeline decided to forward the request to a backend.
	// ForwardBody is the (potentially modified) request body.
	ForwardBody     []byte
	ForwardEndpoint string            // backend "host:port"
	ForwardPath     string            // backend path (e.g., "/v1/chat/completions")
	ForwardHeaders  map[string]string // headers to set on the upstream request
	RemoveHeaders   []string          // headers to strip before forwarding
	IsStreaming     bool              // whether the original request has stream=true
}

// ProviderInfo holds provider details resolved during routing.
type ProviderInfo struct {
	BaseURL string
	APIKey  string
	Type    string // "openai", "anthropic", etc.
}

// ChatCompletionRequest is a minimal representation used for model extraction.
type ChatCompletionRequest struct {
	Model    string        `json:"model"`
	Messages []interface{} `json:"messages"`
	Stream   bool          `json:"stream"`
}

// ErrorResponse is the OpenAI-compatible error format.
type ErrorResponse struct {
	Error ErrorDetail `json:"error"`
}

// ErrorDetail contains the error details.
type ErrorDetail struct {
	Message string `json:"message"`
	Type    string `json:"type"`
	Code    int    `json:"code"`
}

// writeError writes an OpenAI-compatible error response.
func writeError(w http.ResponseWriter, statusCode int, message string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(statusCode)
	resp := ErrorResponse{
		Error: ErrorDetail{
			Message: message,
			Type:    "invalid_request_error",
			Code:    statusCode,
		},
	}
	body, _ := json.Marshal(resp)
	w.Write(body)
}
