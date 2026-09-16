package proxy

import (
	"encoding/json"
	"net/http"
	"time"

	"github.com/regolo-ai/brick-SR1/apps/router/src/spatial-router/pkg/brickrouting"
)

// maxRequestBodySize is the maximum allowed request body size (10 MB).
// Prevents OOM from oversized payloads sent by malicious or buggy clients.
const maxRequestBodySize = 10 << 20

// RoutingResult represents the outcome of running the routing pipeline.
type RoutingResult struct {
	StickyKey string // Conversation identity for cache-aware routing.
	Compacted bool   // Whether this request used a compacted prompt.
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
	IsStreaming     bool              // whether the original request has stream=true
	IsResponses     bool              // native Responses protocol; disables Chat-only body mutation
	Model           string            // selected model name, used for economics tracking
	RoutingSource   string            // "routed" or "native", for durable call history
	ReasoningMode   string
	RoutingMode     string
	// AcceptedAt starts the end-to-end clock at request acceptance. Route is
	// retained only as privacy-safe routing metadata for durable history.
	AcceptedAt       time.Time
	Route            *brickrouting.Result
	RoutingLatencyMS *int64
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
