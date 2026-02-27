package proxy

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	ext_proc "github.com/envoyproxy/go-control-plane/envoy/service/ext_proc/v3"
	typev3 "github.com/envoyproxy/go-control-plane/envoy/type/v3"

	"github.com/vllm-project/semantic-router/src/semantic-router/pkg/extproc"
	"github.com/vllm-project/semantic-router/src/semantic-router/pkg/headers"
)

// runPipeline reads the HTTP request, constructs the ExtProc wrappers,
// runs the routing pipeline, and interprets the result.
// Returns the routing result and the request context (for debug/test endpoints).
func (s *Server) runPipeline(r *http.Request) (*RoutingResult, *extproc.RequestContext, error) {
	// Read request body with size limit to prevent OOM from oversized payloads
	body, err := io.ReadAll(io.LimitReader(r.Body, maxRequestBodySize))
	if err != nil {
		return nil, nil, fmt.Errorf("reading request body: %w", err)
	}
	defer r.Body.Close()

	if len(body) == 0 {
		return nil, nil, fmt.Errorf("empty request body")
	}
	if len(body) >= maxRequestBodySize {
		return nil, nil, fmt.Errorf("request body too large (max %d bytes)", maxRequestBodySize)
	}

	// Check if this is a streaming request
	isStreaming := false
	var rawReq map[string]interface{}
	if err := json.Unmarshal(body, &rawReq); err == nil {
		if stream, ok := rawReq["stream"].(bool); ok {
			isStreaming = stream
		}
	}

	// Initialize the request context (equivalent to what handleRequestHeaders did)
	ctx := &extproc.RequestContext{
		Headers:                 make(map[string]string),
		StartTime:               time.Now(),
		TraceContext:             context.Background(),
		ExpectStreamingResponse: isStreaming,
	}

	// Copy HTTP headers into context (simulates Envoy header extraction)
	for key, values := range r.Header {
		if len(values) > 0 {
			ctx.Headers[strings.ToLower(key)] = values[0]
		}
	}
	// Set pseudo-headers that Envoy would set
	ctx.Headers[":method"] = r.Method
	ctx.Headers[":path"] = r.URL.Path
	ctx.Headers[":authority"] = r.Host

	// Store request ID if present
	if reqID := r.Header.Get("X-Request-Id"); reqID != "" {
		ctx.RequestID = reqID
	}

	// Construct the ExtProc request body wrapper
	extprocBody := &ext_proc.ProcessingRequest_RequestBody{
		RequestBody: &ext_proc.HttpBody{
			Body: body,
		},
	}

	// Run the routing pipeline
	response, err := s.router.HandleRequestBody(extprocBody, ctx)
	if err != nil {
		return nil, ctx, fmt.Errorf("routing pipeline: %w", err)
	}

	// Interpret the ExtProc response
	return interpretResponse(response, body, isStreaming, ctx)
}

// interpretResponse translates an ext_proc.ProcessingResponse into a RoutingResult.
func interpretResponse(
	response *ext_proc.ProcessingResponse,
	originalBody []byte,
	isStreaming bool,
	ctx *extproc.RequestContext,
) (*RoutingResult, *extproc.RequestContext, error) {
	if response == nil {
		// No response means continue without modifications
		return &RoutingResult{
			ForwardBody: originalBody,
			IsStreaming: isStreaming,
		}, ctx, nil
	}

	switch resp := response.Response.(type) {
	case *ext_proc.ProcessingResponse_ImmediateResponse:
		// Direct response — cache hit, error, PII block, jailbreak block, etc.
		return interpretImmediateResponse(resp.ImmediateResponse, ctx)

	case *ext_proc.ProcessingResponse_RequestBody:
		// Continue — extract mutations and build forwarding instructions
		return interpretBodyResponse(resp.RequestBody, originalBody, isStreaming, ctx)

	default:
		return nil, ctx, fmt.Errorf("unexpected response type: %T", response.Response)
	}
}

// interpretImmediateResponse handles direct responses from the pipeline.
func interpretImmediateResponse(
	ir *ext_proc.ImmediateResponse,
	ctx *extproc.RequestContext,
) (*RoutingResult, *extproc.RequestContext, error) {
	statusCode := httpStatusFromEnum(ir.GetStatus().GetCode())

	result := &RoutingResult{
		Direct:     true,
		StatusCode: statusCode,
		Body:       ir.GetBody(),
		Headers:    make(map[string]string),
	}

	// Extract headers from the immediate response
	if ir.Headers != nil {
		for _, h := range ir.Headers.SetHeaders {
			if h.Header != nil {
				result.Headers[h.Header.Key] = string(h.Header.RawValue)
			}
		}
	}

	// Default content-type
	if _, ok := result.Headers["content-type"]; !ok {
		result.Headers["content-type"] = "application/json"
	}

	return result, ctx, nil
}

// interpretBodyResponse handles "continue" responses from the pipeline.
// These contain header and body mutations that tell us where and how to forward.
func interpretBodyResponse(
	br *ext_proc.BodyResponse,
	originalBody []byte,
	isStreaming bool,
	ctx *extproc.RequestContext,
) (*RoutingResult, *extproc.RequestContext, error) {
	if br == nil || br.Response == nil {
		return &RoutingResult{
			ForwardBody: originalBody,
			IsStreaming: isStreaming,
		}, ctx, nil
	}

	result := &RoutingResult{
		ForwardBody:    originalBody,
		ForwardHeaders: make(map[string]string),
		IsStreaming:     isStreaming,
	}

	common := br.Response

	// Extract body mutation
	if common.BodyMutation != nil {
		if bm, ok := common.BodyMutation.Mutation.(*ext_proc.BodyMutation_Body); ok {
			result.ForwardBody = bm.Body
		}
	}

	// Extract header mutations
	if common.HeaderMutation != nil {
		for _, h := range common.HeaderMutation.SetHeaders {
			if h.Header != nil {
				key := h.Header.Key
				value := string(h.Header.RawValue)

				switch key {
				case headers.GatewayDestinationEndpoint:
					result.ForwardEndpoint = value
				case ":path":
					result.ForwardPath = value
				default:
					result.ForwardHeaders[key] = value
				}
			}
		}
		result.RemoveHeaders = common.HeaderMutation.RemoveHeaders
	}

	// Default path if not set by mutations
	if result.ForwardPath == "" {
		result.ForwardPath = "/v1/chat/completions"
	}

	return result, ctx, nil
}

// httpStatusFromEnum converts an Envoy StatusCode enum to an HTTP status code.
func httpStatusFromEnum(code typev3.StatusCode) int {
	switch code {
	case typev3.StatusCode_OK:
		return 200
	case typev3.StatusCode_BadRequest:
		return 400
	case typev3.StatusCode_Unauthorized:
		return 401
	case typev3.StatusCode_Forbidden:
		return 403
	case typev3.StatusCode_NotFound:
		return 404
	case typev3.StatusCode_TooManyRequests:
		return 429
	case typev3.StatusCode_InternalServerError:
		return 500
	case typev3.StatusCode_ServiceUnavailable:
		return 503
	default:
		// The enum value IS the HTTP status code
		return int(code)
	}
}

