package extproc

import (
	ext_proc "github.com/envoyproxy/go-control-plane/envoy/service/ext_proc/v3"
)

// HandleRequestBody is the public entry point for the request routing pipeline.
// It wraps the internal handleRequestBody method so the proxy package can call it.
func (r *OpenAIRouter) HandleRequestBody(v *ext_proc.ProcessingRequest_RequestBody, ctx *RequestContext) (*ext_proc.ProcessingResponse, error) {
	return r.handleRequestBody(v, ctx)
}
