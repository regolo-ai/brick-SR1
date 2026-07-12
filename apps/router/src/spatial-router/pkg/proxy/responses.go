package proxy

// OpenAI Responses API (POST /v1/responses) adapter.
//
// Codex CLI 0.134+ dropped support for wire_api = "chat" and now speaks only the
// Responses protocol: it POSTs {input, instructions, model, stream, reasoning}
// to /v1/responses and expects a semantic SSE event stream back
// (response.created -> output_item.added -> content_part.added ->
// output_text.delta* -> output_text.done -> content_part.done ->
// output_item.done -> response.completed). Codex is strict about that sequence;
// a missing content_part.added is enough to break it.
//
// The Brick router core (handleBrickRequest) only understands Chat Completions
// {messages:[...]} payloads. Rather than teach the whole routing/forwarding
// pipeline a second protocol, this handler adapts at the edges, mirroring how
// handleAnthropicMessages adapts the Anthropic Messages protocol:
//
//  1. Convert the Responses request into a Chat Completions body (input ->
//     messages, instructions -> system message), forcing stream=false so the
//     core returns a single JSON object we can read in full.
//  2. Delegate to handleBrickRequest via an in-process request against a
//     ResponseRecorder, reusing the exact routing, effort, and forwarding logic.
//  3. Convert the captured Chat Completions JSON into the Responses shape: a
//     single JSON object for non-streaming clients, or the full semantic SSE
//     event sequence for streaming clients.
//
// Keeping the upstream call non-streaming means we never have to parse Chat
// Completions SSE deltas; we synthesize the (stricter) Responses event sequence
// from the finished message instead.

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync/atomic"

	"github.com/regolo-ai/brick-SR1/apps/router/src/spatial-router/pkg/headers"
	"github.com/regolo-ai/brick-SR1/apps/router/src/spatial-router/pkg/observability/logging"
)

// responsesRequest is the subset of the OpenAI Responses request body we need.
// Input is decoded lazily (string or array) via json.RawMessage.
type responsesRequest struct {
	Model        string          `json:"model"`
	Instructions string          `json:"instructions"`
	Input        json.RawMessage `json:"input"`
	Stream       bool            `json:"stream"`
	Reasoning    *struct {
		Effort string `json:"effort"`
	} `json:"reasoning"`
}

// responsesInputItem is one element of an `input` array (Responses format).
// Content may be a plain string or an array of typed parts ({type, text}).
type responsesInputItem struct {
	Type    string          `json:"type"`
	Role    string          `json:"role"`
	Content json.RawMessage `json:"content"`
}

// chatMessage is a Chat Completions message we emit toward the router core.
type chatMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

// handleResponses adapts POST /v1/responses to the Chat Completions router core.
func (s *Server) handleResponses(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	if s.cfg == nil || !s.cfg.Brick.Enabled {
		writeError(w, http.StatusBadRequest, "Brick gateway is not enabled")
		return
	}

	body, err := io.ReadAll(io.LimitReader(r.Body, maxRequestBodySize))
	if err != nil {
		writeError(w, http.StatusBadRequest, fmt.Sprintf("reading request body: %v", err))
		return
	}
	defer r.Body.Close()
	if len(body) == 0 {
		writeError(w, http.StatusBadRequest, "empty request body")
		return
	}
	if len(body) >= maxRequestBodySize {
		writeError(w, http.StatusRequestEntityTooLarge,
			fmt.Sprintf("request body too large (max %d bytes)", maxRequestBodySize))
		return
	}

	var req responsesRequest
	if err := json.Unmarshal(body, &req); err != nil {
		writeError(w, http.StatusBadRequest, fmt.Sprintf("invalid JSON: %v", err))
		return
	}

	messages, err := responsesToChatMessages(&req)
	if err != nil {
		writeError(w, http.StatusBadRequest, fmt.Sprintf("invalid Responses input: %v", err))
		return
	}
	if len(messages) == 0 {
		writeError(w, http.StatusBadRequest, "Responses request has no input content")
		return
	}

	clientWantsStream := req.Stream

	// Build the Chat Completions body for the router core. Always forces
	// stream=false upstream: we read the full JSON response and (re)synthesize
	// the Responses SSE sequence ourselves. model is pinned to "brick" so the
	// virtual router runs regardless of the model id Codex sent.
	chatBody := map[string]interface{}{
		"model":    "brick",
		"messages": messages,
		"stream":   false,
	}
	// Carry the reasoning effort through in the OpenAI-compatible field the core
	// already understands; the router may still override it autonomously.
	if req.Reasoning != nil && req.Reasoning.Effort != "" {
		chatBody["reasoning_effort"] = req.Reasoning.Effort
	}
	chatBytes, err := json.Marshal(chatBody)
	if err != nil {
		writeError(w, http.StatusInternalServerError, fmt.Sprintf("building chat request: %v", err))
		return
	}

	// Delegate to the Chat Completions core in-process. A ResponseRecorder
	// captures the core's JSON response without touching the real client writer.
	innerReq := r.Clone(r.Context())
	innerReq.Body = io.NopCloser(bytes.NewReader(chatBytes))
	innerReq.ContentLength = int64(len(chatBytes))
	innerReq.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	s.handleBrickRequest(rec, innerReq)

	if rec.Code != http.StatusOK {
		// Surface the core's error verbatim (already OpenAI-shaped JSON).
		for k, vs := range rec.Header() {
			for _, v := range vs {
				w.Header().Add(k, v)
			}
		}
		w.WriteHeader(rec.Code)
		w.Write(rec.Body.Bytes())
		return
	}

	text, usage := extractChatCompletion(rec.Body.Bytes())
	selectedModel := rec.Header().Get(headers.VSRSelectedModel)
	if selectedModel == "" {
		selectedModel = req.Model
	}
	if selectedModel == "" {
		selectedModel = "brick"
	}

	if clientWantsStream {
		writeResponsesSSE(w, text, selectedModel, usage)
		return
	}
	writeResponsesJSON(w, text, selectedModel, usage)
}

// responsesToChatMessages converts a Responses request (instructions + input)
// into Chat Completions messages. instructions become a leading system message;
// input may be a plain string (single user message) or an array of role/content
// items.
func responsesToChatMessages(req *responsesRequest) ([]chatMessage, error) {
	var msgs []chatMessage
	if strings.TrimSpace(req.Instructions) != "" {
		msgs = append(msgs, chatMessage{Role: "system", Content: req.Instructions})
	}

	if len(req.Input) == 0 {
		return msgs, nil
	}

	// input as a plain string.
	var asString string
	if err := json.Unmarshal(req.Input, &asString); err == nil {
		if strings.TrimSpace(asString) != "" {
			msgs = append(msgs, chatMessage{Role: "user", Content: asString})
		}
		return msgs, nil
	}

	// input as an array of items.
	var items []responsesInputItem
	if err := json.Unmarshal(req.Input, &items); err != nil {
		return nil, fmt.Errorf("input is neither string nor array: %w", err)
	}
	for _, it := range items {
		role := it.Role
		if role == "" {
			role = "user"
		}
		content := extractInputItemText(it.Content)
		if strings.TrimSpace(content) == "" {
			continue
		}
		msgs = append(msgs, chatMessage{Role: role, Content: content})
	}
	return msgs, nil
}

// extractInputItemText flattens a Responses content value (string, or array of
// {type, text} parts) into a plain string.
func extractInputItemText(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var asString string
	if err := json.Unmarshal(raw, &asString); err == nil {
		return asString
	}
	var parts []struct {
		Type string `json:"type"`
		Text string `json:"text"`
	}
	if err := json.Unmarshal(raw, &parts); err != nil {
		return ""
	}
	var b strings.Builder
	for _, p := range parts {
		if p.Text != "" {
			b.WriteString(p.Text)
		}
	}
	return b.String()
}

// extractChatCompletion pulls the assistant text and usage out of a
// non-streaming Chat Completions response body. Missing fields degrade to empty
// text and zero usage rather than erroring.
func extractChatCompletion(body []byte) (string, responsesUsage) {
	var decoded struct {
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
		Usage struct {
			PromptTokens     int64 `json:"prompt_tokens"`
			CompletionTokens int64 `json:"completion_tokens"`
			TotalTokens      int64 `json:"total_tokens"`
		} `json:"usage"`
	}
	if err := json.Unmarshal(body, &decoded); err != nil {
		logging.Warnf("responses: could not decode chat completion: %v", err)
		return "", responsesUsage{}
	}
	text := ""
	if len(decoded.Choices) > 0 {
		text = decoded.Choices[0].Message.Content
	}
	u := responsesUsage{
		InputTokens:  decoded.Usage.PromptTokens,
		OutputTokens: decoded.Usage.CompletionTokens,
		TotalTokens:  decoded.Usage.TotalTokens,
	}
	if u.TotalTokens == 0 {
		u.TotalTokens = u.InputTokens + u.OutputTokens
	}
	return text, u
}

// responsesUsage mirrors the Responses API usage object (input_tokens /
// output_tokens / total_tokens), which differs from the Chat Completions naming.
type responsesUsage struct {
	InputTokens  int64 `json:"input_tokens"`
	OutputTokens int64 `json:"output_tokens"`
	TotalTokens  int64 `json:"total_tokens"`
}

// responseObject builds the completed Responses object returned both by the
// non-streaming path and inside the final response.completed SSE event.
func responseObject(id, model, text string, usage responsesUsage, status string) map[string]interface{} {
	return map[string]interface{}{
		"id":         id,
		"object":     "response",
		"status":     status,
		"model":      model,
		"output": []map[string]interface{}{
			{
				"type":   "message",
				"id":     id + "-msg",
				"status": "completed",
				"role":   "assistant",
				"content": []map[string]interface{}{
					{"type": "output_text", "text": text, "annotations": []interface{}{}},
				},
			},
		},
		"usage": usage,
	}
}

// writeResponsesJSON writes a non-streaming Responses object.
func writeResponsesJSON(w http.ResponseWriter, text, model string, usage responsesUsage) {
	obj := responseObject(newResponseID(), model, text, usage, "completed")
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	if err := json.NewEncoder(w).Encode(obj); err != nil {
		logging.Errorf("responses: writing JSON response: %v", err)
	}
}

// writeResponsesSSE emits the full semantic Responses event sequence Codex
// expects. The whole assistant message is delivered as a single
// output_text.delta (the upstream call was non-streaming, so we already have the
// complete text); the surrounding lifecycle events are what Codex is strict
// about.
func writeResponsesSSE(w http.ResponseWriter, text, model string, usage responsesUsage) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		// No streaming support: degrade to a single JSON object.
		writeResponsesJSON(w, text, model, usage)
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.WriteHeader(http.StatusOK)

	id := newResponseID()
	itemID := id + "-msg"

	created := responseObject(id, model, "", responsesUsage{}, "in_progress")
	emit := func(event string, payload map[string]interface{}) {
		payload["type"] = event
		data, err := json.Marshal(payload)
		if err != nil {
			logging.Errorf("responses: marshaling SSE event %s: %v", event, err)
			return
		}
		fmt.Fprintf(w, "event: %s\ndata: %s\n\n", event, data)
		flusher.Flush()
	}

	emit("response.created", map[string]interface{}{"response": created})
	emit("response.in_progress", map[string]interface{}{"response": created})
	emit("response.output_item.added", map[string]interface{}{
		"output_index": 0,
		"item": map[string]interface{}{
			"type": "message", "id": itemID, "status": "in_progress", "role": "assistant",
			"content": []interface{}{},
		},
	})
	emit("response.content_part.added", map[string]interface{}{
		"item_id": itemID, "output_index": 0, "content_index": 0,
		"part": map[string]interface{}{"type": "output_text", "text": "", "annotations": []interface{}{}},
	})
	if text != "" {
		emit("response.output_text.delta", map[string]interface{}{
			"item_id": itemID, "output_index": 0, "content_index": 0, "delta": text,
		})
	}
	emit("response.output_text.done", map[string]interface{}{
		"item_id": itemID, "output_index": 0, "content_index": 0, "text": text,
	})
	emit("response.content_part.done", map[string]interface{}{
		"item_id": itemID, "output_index": 0, "content_index": 0,
		"part": map[string]interface{}{"type": "output_text", "text": text, "annotations": []interface{}{}},
	})
	emit("response.output_item.done", map[string]interface{}{
		"output_index": 0,
		"item": map[string]interface{}{
			"type": "message", "id": itemID, "status": "completed", "role": "assistant",
			"content": []map[string]interface{}{
				{"type": "output_text", "text": text, "annotations": []interface{}{}},
			},
		},
	})
	emit("response.completed", map[string]interface{}{
		"response": responseObject(id, model, text, usage, "completed"),
	})
}

// newResponseID returns a Responses-style identifier. Uniqueness within a
// process comes from a monotonic counter, avoiding a time/random dependency.
func newResponseID() string {
	return "resp_" + nextSeqID()
}

// responsesSeq backs nextSeqID; incremented atomically per generated id.
var responsesSeq uint64

// nextSeqID returns a process-unique, monotonically increasing token.
func nextSeqID() string {
	return strconv.FormatUint(atomic.AddUint64(&responsesSeq, 1), 36)
}
