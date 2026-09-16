// Portions of this adapter are derived from CLIProxyAPI commit
// 09a29bd345bc44c473abe7fd07859e32df2ea543, licensed under the MIT License.
// See THIRD_PARTY_NOTICES.md for attribution.
package codextransport

import (
	"bufio"
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
)

type ToolIdentity struct {
	ChatName, Name, Namespace string
	Custom                    bool
}
type ToolRegistry struct {
	byChat  map[string]ToolIdentity
	byLocal map[string][]ToolIdentity
	byCall  map[string]ToolIdentity
}
type AdaptedChat struct {
	Body  []byte
	Tools *ToolRegistry
}

func newToolRegistry() *ToolRegistry {
	return &ToolRegistry{map[string]ToolIdentity{}, map[string][]ToolIdentity{}, map[string]ToolIdentity{}}
}
func qualifyTool(namespace, name string) string {
	if namespace == "" || strings.HasPrefix(name, "mcp__") || strings.HasPrefix(name, namespace+"__") {
		return name
	}
	return strings.TrimSuffix(namespace, "__") + "__" + name
}
func (r *ToolRegistry) add(identity ToolIdentity) error {
	if identity.Name == "" || identity.ChatName == "" {
		return fmt.Errorf("tool name is required")
	}
	if previous, exists := r.byChat[identity.ChatName]; exists {
		return fmt.Errorf("ambiguous tool collision for %q (%s/%s and %s/%s)", identity.ChatName, previous.Namespace, previous.Name, identity.Namespace, identity.Name)
	}
	r.byChat[identity.ChatName] = identity
	r.byLocal[identity.Name] = append(r.byLocal[identity.Name], identity)
	return nil
}
func (r *ToolRegistry) resolve(name, namespace string) (ToolIdentity, error) {
	if namespace != "" {
		identity, ok := r.byChat[qualifyTool(namespace, name)]
		if ok && identity.Name == name && identity.Namespace == namespace {
			return identity, nil
		}
		return ToolIdentity{}, fmt.Errorf("tool %s/%s was not declared", namespace, name)
	}
	if identity, ok := r.byChat[name]; ok {
		return identity, nil
	}
	candidates := r.byLocal[name]
	if len(candidates) != 1 {
		return ToolIdentity{}, fmt.Errorf("tool name %q is undeclared or ambiguous", name)
	}
	return candidates[0], nil
}

func registerToolList(registry *ToolRegistry, values []any, namespace string, mapped *[]any) error {
	for _, value := range values {
		tool, ok := value.(map[string]any)
		if !ok {
			return fmt.Errorf("invalid tool declaration")
		}
		typ, _ := tool["type"].(string)
		if typ == "namespace" {
			name, _ := tool["name"].(string)
			children, ok := tool["tools"].([]any)
			if !ok || name == "" || namespace != "" {
				return fmt.Errorf("invalid or nested tool namespace")
			}
			if err := registerToolList(registry, children, name, mapped); err != nil {
				return err
			}
			continue
		}
		if typ != "function" && typ != "custom" {
			return fmt.Errorf("Chat adapter cannot represent hosted tool %q", typ)
		}
		name, _ := tool["name"].(string)
		identity := ToolIdentity{qualifyTool(namespace, name), name, namespace, typ == "custom"}
		if err := registry.add(identity); err != nil {
			return err
		}
		fn := map[string]any{"name": identity.ChatName}
		if description, ok := tool["description"].(string); ok && description != "" {
			fn["description"] = description
		}
		if identity.Custom {
			description := "Free-form input for this custom tool."
			if format, exists := tool["format"]; exists {
				encoded, err := json.Marshal(format)
				if err != nil {
					return fmt.Errorf("invalid custom tool format")
				}
				description += " Required format: " + string(encoded)
			}
			fn["parameters"] = map[string]any{"type": "object", "properties": map[string]any{"input": map[string]any{"type": "string", "description": description}}, "required": []string{"input"}, "additionalProperties": false}
		} else {
			parameters, ok := tool["parameters"]
			if !ok {
				parameters = map[string]any{"type": "object", "properties": map[string]any{}}
			}
			fn["parameters"] = parameters
			if strict, ok := tool["strict"].(bool); ok {
				fn["strict"] = strict
			}
		}
		*mapped = append(*mapped, map[string]any{"type": "function", "function": fn})
	}
	return nil
}

// PrepareChat validates the complete Responses request, builds a request-local
// tool identity registry, and converts only fields with an explicit policy.
func PrepareChat(body []byte) (*AdaptedChat, error) {
	var request map[string]any
	if err := json.Unmarshal(body, &request); err != nil || request == nil {
		return nil, fmt.Errorf("invalid request")
	}
	allowed := map[string]bool{}
	for _, key := range []string{"model", "input", "instructions", "tools", "tool_choice", "parallel_tool_calls", "stream", "temperature", "top_p", "max_output_tokens", "reasoning", "text", "store", "metadata", "service_tier", "safety_identifier", "prompt_cache_key", "prompt_cache_retention", "user", "include", "background", "truncation", "client_metadata"} {
		allowed[key] = true
	}
	for key := range request {
		if !allowed[key] {
			return nil, fmt.Errorf("Chat adapter has no field policy for %q", key)
		}
	}
	if include, ok := request["include"].([]any); ok {
		for _, value := range include {
			if value != "reasoning.encrypted_content" {
				return nil, fmt.Errorf("Chat adapter cannot represent include value %q", value)
			}
		}
	}
	if background, _ := request["background"].(bool); background {
		return nil, fmt.Errorf("Chat adapter cannot represent background responses")
	}
	if truncation, ok := request["truncation"].(string); ok && truncation != "disabled" {
		return nil, fmt.Errorf("Chat adapter cannot apply Responses truncation")
	}

	registry := newToolRegistry()
	mappedTools := []any{}
	if values, ok := request["tools"].([]any); ok {
		if err := registerToolList(registry, values, "", &mappedTools); err != nil {
			return nil, err
		}
	} else if request["tools"] != nil {
		return nil, fmt.Errorf("invalid tools")
	}
	if input, ok := request["input"].([]any); ok {
		for _, value := range input {
			item, _ := value.(map[string]any)
			if item["type"] == "additional_tools" {
				values, ok := item["tools"].([]any)
				if !ok {
					return nil, fmt.Errorf("invalid additional_tools item")
				}
				if err := registerToolList(registry, values, "", &mappedTools); err != nil {
					return nil, err
				}
			}
		}
	}

	out := map[string]any{}
	for _, key := range []string{"model", "stream", "temperature", "top_p", "parallel_tool_calls", "store", "metadata", "service_tier", "safety_identifier", "prompt_cache_key", "prompt_cache_retention", "user"} {
		if value, ok := request[key]; ok {
			out[key] = value
		}
	}
	if value, ok := request["max_output_tokens"]; ok {
		out["max_completion_tokens"] = value
	} else {
		// Responses leaves the output limit model-defined. Several compatible
		// Chat gateways instead default to their full remaining context, which
		// can make an otherwise valid Codex request exceed the model window.
		out["max_completion_tokens"] = 8192
	}
	if reasoning, ok := request["reasoning"].(map[string]any); ok {
		for key := range reasoning {
			if key != "effort" && key != "summary" && key != "context" {
				return nil, fmt.Errorf("Chat adapter cannot represent reasoning field %q", key)
			}
		}
		if effort, exists := reasoning["effort"]; exists {
			out["reasoning_effort"] = effort
		}
	} else if request["reasoning"] != nil {
		return nil, fmt.Errorf("invalid reasoning settings")
	}
	if text, ok := request["text"].(map[string]any); ok {
		if format, ok := text["format"].(map[string]any); ok {
			typ, _ := format["type"].(string)
			switch typ {
			case "text", "":
			case "json_object":
				out["response_format"] = map[string]any{"type": "json_object"}
			case "json_schema":
				copy := map[string]any{}
				for _, key := range []string{"name", "description", "schema", "strict"} {
					if value, exists := format[key]; exists {
						copy[key] = value
					}
				}
				out["response_format"] = map[string]any{"type": "json_schema", "json_schema": copy}
			default:
				return nil, fmt.Errorf("unsupported text format %q", typ)
			}
		}
	}

	messages := []any{}
	appendMessage := func(role string, content any) {
		if role == "developer" {
			role = "system"
		}
		if role == "system" {
			content = textOnlyContent(content)
			if len(messages) > 0 {
				if previous, ok := messages[len(messages)-1].(map[string]any); ok && previous["role"] == "system" {
					previous["content"] = strings.TrimSuffix(previous["content"].(string), "\n") + "\n\n" + content.(string)
					return
				}
			}
		}
		messages = append(messages, map[string]any{"role": role, "content": content})
	}
	if instructions, exists := request["instructions"]; exists {
		if _, ok := instructions.(string); !ok {
			return nil, fmt.Errorf("instructions must be text")
		}
		appendMessage("system", instructions)
	}
	appendCall := func(call map[string]any) {
		if len(messages) > 0 {
			if previous, ok := messages[len(messages)-1].(map[string]any); ok && previous["role"] == "assistant" && previous["tool_calls"] != nil {
				previous["tool_calls"] = append(previous["tool_calls"].([]any), call)
				return
			}
		}
		messages = append(messages, map[string]any{"role": "assistant", "tool_calls": []any{call}})
	}
	appendItem := func(item map[string]any) error {
		typ, _ := item["type"].(string)
		switch typ {
		case "additional_tools", "reasoning", "compaction":
			return nil
		case "", "message":
			role, _ := item["role"].(string)
			if role != "user" && role != "assistant" && role != "system" && role != "developer" {
				return fmt.Errorf("unsupported role %q", role)
			}
			content, err := chatContent(item["content"])
			if err != nil {
				return err
			}
			appendMessage(role, content)
			return nil
		case "function_call", "custom_tool_call":
			name, _ := item["name"].(string)
			namespace, _ := item["namespace"].(string)
			identity, err := registry.resolve(name, namespace)
			if err != nil {
				return err
			}
			if (typ == "custom_tool_call") != identity.Custom {
				return fmt.Errorf("tool call type conflicts with declaration for %q", name)
			}
			callID, _ := item["call_id"].(string)
			if callID == "" {
				return fmt.Errorf("tool call requires call_id")
			}
			arguments, _ := item["arguments"].(string)
			if identity.Custom {
				input, ok := item["input"].(string)
				if !ok {
					return fmt.Errorf("custom tool input must be text")
				}
				encoded, _ := json.Marshal(map[string]string{"input": input})
				arguments = string(encoded)
			}
			registry.byCall[callID] = identity
			appendCall(map[string]any{"id": callID, "type": "function", "function": map[string]any{"name": identity.ChatName, "arguments": arguments}})
			return nil
		case "function_call_output", "custom_tool_call_output":
			callID, _ := item["call_id"].(string)
			if callID == "" {
				return fmt.Errorf("tool result requires call_id")
			}
			identity, exists := registry.byCall[callID]
			if exists && (typ == "custom_tool_call_output") != identity.Custom {
				return fmt.Errorf("tool result type conflicts with call %q", callID)
			}
			output, err := toolOutputText(item["output"])
			if err != nil {
				return err
			}
			messages = append(messages, map[string]any{"role": "tool", "tool_call_id": callID, "content": output})
			return nil
		default:
			return fmt.Errorf("Chat adapter cannot represent input type %q", typ)
		}
	}
	switch input := request["input"].(type) {
	case string:
		messages = append(messages, map[string]any{"role": "user", "content": input})
	case []any:
		for _, value := range input {
			item, ok := value.(map[string]any)
			if !ok {
				return nil, fmt.Errorf("invalid input item")
			}
			if err := appendItem(item); err != nil {
				return nil, err
			}
		}
	default:
		return nil, fmt.Errorf("input must be text or items")
	}
	out["messages"] = messages
	if len(mappedTools) > 0 {
		out["tools"] = mappedTools
	}
	if choice, exists := request["tool_choice"]; exists {
		switch value := choice.(type) {
		case string:
			if value != "auto" && value != "none" && value != "required" {
				return nil, fmt.Errorf("invalid tool_choice")
			}
			out["tool_choice"] = value
		case map[string]any:
			name, _ := value["name"].(string)
			namespace, _ := value["namespace"].(string)
			identity, err := registry.resolve(name, namespace)
			if err != nil {
				return nil, err
			}
			out["tool_choice"] = map[string]any{"type": "function", "function": map[string]any{"name": identity.ChatName}}
		default:
			return nil, fmt.Errorf("unsupported tool_choice")
		}
	}
	if out["stream"] == true {
		out["stream_options"] = map[string]any{"include_usage": true}
	}
	encoded, err := json.Marshal(out)
	if err != nil {
		return nil, err
	}
	return &AdaptedChat{encoded, registry}, nil
}

func textOnlyContent(content any) string {
	if text, ok := content.(string); ok {
		return text
	}
	parts, _ := content.([]any)
	var result strings.Builder
	for _, value := range parts {
		if part, ok := value.(map[string]any); ok {
			if text, ok := part["text"].(string); ok {
				result.WriteString(text)
			}
		}
	}
	return result.String()
}

func chatContent(value any) (any, error) {
	if text, ok := value.(string); ok {
		return text, nil
	}
	parts, ok := value.([]any)
	if !ok {
		return nil, fmt.Errorf("unsupported message content")
	}
	mapped := make([]any, 0, len(parts))
	for _, value := range parts {
		part, ok := value.(map[string]any)
		if !ok {
			return nil, fmt.Errorf("invalid content part")
		}
		typ, _ := part["type"].(string)
		switch typ {
		case "input_text", "output_text", "text":
			text, ok := part["text"].(string)
			if !ok {
				return nil, fmt.Errorf("text must be a string")
			}
			mapped = append(mapped, map[string]any{"type": "text", "text": text})
		case "input_image":
			url, ok := part["image_url"].(string)
			if !ok {
				return nil, fmt.Errorf("image_url must be a string")
			}
			image := map[string]any{"url": url}
			if detail, ok := part["detail"].(string); ok {
				image["detail"] = detail
			}
			mapped = append(mapped, map[string]any{"type": "image_url", "image_url": image})
		case "input_audio", "input_file":
			mapped = append(mapped, part)
		default:
			return nil, fmt.Errorf("unsupported message content type %q", typ)
		}
	}
	return mapped, nil
}
func toolOutputText(value any) (string, error) {
	if text, ok := value.(string); ok {
		return text, nil
	}
	parts, ok := value.([]any)
	if !ok {
		return "", fmt.Errorf("tool output must be text or text parts")
	}
	var output strings.Builder
	for _, value := range parts {
		part, ok := value.(map[string]any)
		if !ok {
			return "", fmt.Errorf("invalid tool output part")
		}
		typ, _ := part["type"].(string)
		if typ != "input_text" && typ != "output_text" && typ != "text" {
			return "", fmt.Errorf("unsupported tool output type %q", typ)
		}
		text, ok := part["text"].(string)
		if !ok {
			return "", fmt.Errorf("tool output text must be a string")
		}
		output.WriteString(text)
	}
	return output.String(), nil
}

func ForwardChat(w http.ResponseWriter, r *http.Request, client *http.Client, endpoint, provider, key string, adapted *AdaptedChat) {
	req, err := http.NewRequestWithContext(r.Context(), http.MethodPost, endpoint, bytes.NewReader(adapted.Body))
	if err != nil {
		http.Error(w, "invalid upstream", http.StatusBadGateway)
		return
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+key)
	isolated := *client
	isolated.CheckRedirect = func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse }
	response, err := isolated.Do(req)
	if err != nil {
		http.Error(w, "upstream transport failed: "+provider, http.StatusBadGateway)
		return
	}
	defer response.Body.Close()
	w.Header().Set("X-Brick-Provider", provider)
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		var upstreamError struct {
			Error struct {
				Type    string `json:"type"`
				Code    any    `json:"code"`
				Message string `json:"message"`
			} `json:"error"`
		}
		_ = json.NewDecoder(io.LimitReader(response.Body, 1<<20)).Decode(&upstreamError)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadGateway)
		errorBody := map[string]any{"type": "provider_error", "provider": provider, "upstream_status": response.StatusCode}
		if upstreamError.Error.Type != "" {
			errorBody["upstream_type"] = upstreamError.Error.Type
		}
		if upstreamError.Error.Code != nil {
			errorBody["upstream_code"] = upstreamError.Error.Code
		}
		if upstreamError.Error.Message != "" {
			errorBody["message"] = upstreamError.Error.Message
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"error": errorBody})
		return
	}
	var request struct {
		Stream bool   `json:"stream"`
		Model  string `json:"model"`
	}
	_ = json.Unmarshal(adapted.Body, &request)
	state := chatEvents{w: w, stream: request.Stream, model: request.Model, tools: adapted.Tools, calls: map[int]*pendingCall{}, status: "in_progress"}
	if !request.Stream {
		var value map[string]any
		if err := json.NewDecoder(io.LimitReader(response.Body, 32<<20)).Decode(&value); err != nil {
			http.Error(w, "invalid Chat response", http.StatusBadGateway)
			return
		}
		if err := state.consume(value, false); err != nil {
			http.Error(w, "unsupported Chat response: "+err.Error(), http.StatusBadGateway)
			return
		}
		if err := state.finishCalls(); err != nil {
			http.Error(w, "unsupported Chat response: "+err.Error(), http.StatusBadGateway)
			return
		}
		if state.status == "in_progress" {
			http.Error(w, "incomplete Chat response", http.StatusBadGateway)
			return
		}
		state.finishItems()
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(state.object(state.status))
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	state.emit("response.created", map[string]any{"response": state.object("in_progress")})
	scanner := bufio.NewScanner(response.Body)
	scanner.Buffer(make([]byte, 4096), 4<<20)
	var failure error
	for scanner.Scan() {
		line := scanner.Text()
		if !strings.HasPrefix(line, "data:") {
			continue
		}
		data := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
		if data == "[DONE]" {
			break
		}
		var value map[string]any
		if json.Unmarshal([]byte(data), &value) != nil {
			failure = fmt.Errorf("invalid upstream event")
			break
		}
		if err := state.consume(value, true); err != nil {
			failure = err
			break
		}
	}
	if failure == nil {
		failure = scanner.Err()
	}
	if failure == nil {
		failure = state.finishCalls()
	}
	if failure != nil || state.status == "in_progress" || state.status == "failed" {
		message := "upstream stream ended before a terminal event"
		if failure != nil {
			message = failure.Error()
		}
		state.emit("response.failed", map[string]any{"response": map[string]any{"status": "failed", "error": map[string]any{"code": "provider_stream_error", "message": message}}})
		return
	}
	state.finishItems()
	event := "response.completed"
	if state.status == "incomplete" {
		event = "response.incomplete"
	}
	state.emit(event, map[string]any{"response": state.object(state.status)})
}

type pendingCall struct {
	id, name, arguments    string
	itemIndex, emittedArgs int
}
type chatEvents struct {
	w                       http.ResponseWriter
	stream                  bool
	model, id, text, status string
	items                   []map[string]any
	calls                   map[int]*pendingCall
	tools                   *ToolRegistry
	seq                     int
	usage                   any
}

func stableID(prefix, responseID string, index int, name string) string {
	sum := sha256.Sum256([]byte(fmt.Sprintf("%s\x00%d\x00%s", responseID, index, name)))
	return prefix + hex.EncodeToString(sum[:12])
}
func (s *chatEvents) ensureResponseID(upstream string) {
	if s.id == "" {
		if upstream != "" {
			s.id = upstream
		} else {
			s.id = stableID("resp_", s.model, 0, "response")
		}
	}
}
func (s *chatEvents) object(status string) map[string]any {
	s.ensureResponseID("")
	items := s.items
	if items == nil {
		items = []map[string]any{}
	}
	return map[string]any{"id": s.id, "object": "response", "model": s.model, "status": status, "output": items, "usage": s.usage}
}
func (s *chatEvents) emit(kind string, payload map[string]any) {
	if !s.stream {
		return
	}
	payload["type"] = kind
	payload["sequence_number"] = s.seq
	s.seq++
	encoded, _ := json.Marshal(payload)
	_, _ = fmt.Fprintf(s.w, "event: %s\ndata: %s\n\n", kind, encoded)
	if flusher, ok := s.w.(http.Flusher); ok {
		flusher.Flush()
	}
}
func (s *chatEvents) consume(value map[string]any, stream bool) error {
	if value["error"] != nil {
		s.status = "failed"
		return fmt.Errorf("upstream error")
	}
	upstreamID, _ := value["id"].(string)
	s.ensureResponseID(upstreamID)
	if usage, ok := value["usage"].(map[string]any); ok {
		detailsOut := map[string]any{"cached_tokens": float64(0)}
		if details, ok := usage["prompt_tokens_details"].(map[string]any); ok && details["cached_tokens"] != nil {
			detailsOut["cached_tokens"] = details["cached_tokens"]
		}
		s.usage = map[string]any{"input_tokens": usage["prompt_tokens"], "output_tokens": usage["completion_tokens"], "total_tokens": usage["total_tokens"], "input_tokens_details": detailsOut, "output_tokens_details": map[string]any{"reasoning_tokens": float64(0)}}
	}
	choices, _ := value["choices"].([]any)
	if len(choices) > 1 {
		return fmt.Errorf("multiple choices unsupported")
	}
	for _, rawChoice := range choices {
		choice, ok := rawChoice.(map[string]any)
		if !ok {
			return fmt.Errorf("invalid choice")
		}
		if finish := choice["finish_reason"]; finish != nil {
			switch finish {
			case "stop", "tool_calls":
				s.status = "completed"
			case "length":
				s.status = "incomplete"
			default:
				s.status = "failed"
				return fmt.Errorf("unsuccessful finish %v", finish)
			}
		}
		field := "message"
		if stream {
			field = "delta"
		}
		message, _ := choice[field].(map[string]any)
		for key, fieldValue := range message {
			if fieldValue != nil && key != "role" && key != "content" && key != "tool_calls" && key != "refusal" && key != "reasoning_content" && key != "reasoning" {
				return fmt.Errorf("unsupported Chat output field %q", key)
			}
		}
		if refusal, _ := message["refusal"].(string); refusal != "" {
			return fmt.Errorf("provider refusal")
		}
		if text, ok := message["content"].(string); ok && text != "" {
			s.consumeText(text)
		}
		toolCalls, _ := message["tool_calls"].([]any)
		for position, rawCall := range toolCalls {
			call, ok := rawCall.(map[string]any)
			if !ok {
				return fmt.Errorf("invalid tool call")
			}
			index := position
			if stream {
				number, ok := call["index"].(float64)
				if !ok {
					return fmt.Errorf("tool index missing")
				}
				index = int(number)
			}
			pending := s.calls[index]
			if pending == nil {
				pending = &pendingCall{itemIndex: -1}
				s.calls[index] = pending
			}
			if id, _ := call["id"].(string); id != "" {
				if pending.id != "" && pending.id != id {
					return fmt.Errorf("tool identifier changed")
				}
				pending.id = id
			}
			function, _ := call["function"].(map[string]any)
			if name, _ := function["name"].(string); name != "" {
				if pending.name == "" {
					pending.name = name
				} else if pending.name != name {
					pending.name += name
				}
			}
			if arguments, ok := function["arguments"].(string); ok {
				pending.arguments += arguments
			}
			if err := s.materializeCall(index, pending); err != nil {
				return err
			}
		}
	}
	return nil
}
func (s *chatEvents) consumeText(delta string) {
	index := -1
	for i, item := range s.items {
		if item["type"] == "message" {
			index = i
		}
	}
	if index < 0 {
		index = len(s.items)
		item := map[string]any{"type": "message", "id": stableID("msg_", s.id, index, "message"), "role": "assistant", "status": "in_progress", "content": []any{}}
		s.items = append(s.items, item)
		s.emit("response.output_item.added", map[string]any{"output_index": index, "item": item})
		s.emit("response.content_part.added", map[string]any{"item_id": item["id"], "output_index": index, "content_index": 0, "part": map[string]any{"type": "output_text", "text": "", "annotations": []any{}}})
	}
	s.text += delta
	item := s.items[index]
	item["content"] = []any{map[string]any{"type": "output_text", "text": s.text, "annotations": []any{}}}
	s.emit("response.output_text.delta", map[string]any{"item_id": item["id"], "output_index": index, "content_index": 0, "delta": delta})
}
func (s *chatEvents) materializeCall(index int, pending *pendingCall) error {
	if pending.name == "" {
		return nil
	}
	identity, ok := s.tools.byChat[pending.name]
	if !ok {
		return nil
	}
	if pending.itemIndex < 0 {
		if pending.id == "" {
			pending.id = stableID("call_", s.id, index, pending.name)
		}
		pending.itemIndex = len(s.items)
		item := map[string]any{"type": "function_call", "id": pending.id, "call_id": pending.id, "name": identity.Name, "arguments": "", "status": "in_progress"}
		if identity.Custom {
			item["type"] = "custom_tool_call"
			item["input"] = ""
			delete(item, "arguments")
		}
		if identity.Namespace != "" {
			item["namespace"] = identity.Namespace
		}
		s.items = append(s.items, item)
		s.emit("response.output_item.added", map[string]any{"output_index": pending.itemIndex, "item": item})
	}
	if len(pending.arguments) > pending.emittedArgs {
		delta := pending.arguments[pending.emittedArgs:]
		pending.emittedArgs = len(pending.arguments)
		if !identity.Custom {
			s.items[pending.itemIndex]["arguments"] = pending.arguments
			s.emit("response.function_call_arguments.delta", map[string]any{"item_id": pending.id, "output_index": pending.itemIndex, "delta": delta})
		}
	}
	return nil
}
func (s *chatEvents) finishCalls() error {
	for index, pending := range s.calls {
		identity, err := s.tools.resolve(pending.name, "")
		if err != nil {
			return fmt.Errorf("provider returned undeclared or ambiguous tool %q", pending.name)
		}
		pending.name = identity.ChatName
		if err := s.materializeCall(index, pending); err != nil {
			return err
		}
		item := s.items[pending.itemIndex]
		if identity.Custom {
			var wrapper map[string]json.RawMessage
			if json.Unmarshal([]byte(pending.arguments), &wrapper) != nil || len(wrapper) != 1 || wrapper["input"] == nil {
				return fmt.Errorf("custom tool %q returned an invalid input container", identity.Name)
			}
			var input string
			if json.Unmarshal(wrapper["input"], &input) != nil {
				return fmt.Errorf("custom tool %q input is not a string", identity.Name)
			}
			item["input"] = input
		}
	}
	return nil
}
func (s *chatEvents) finishItems() {
	for index, item := range s.items {
		item["status"] = "completed"
		switch item["type"] {
		case "function_call":
			s.emit("response.function_call_arguments.done", map[string]any{"item_id": item["id"], "output_index": index, "arguments": item["arguments"]})
		case "custom_tool_call":
			s.emit("response.custom_tool_call_input.done", map[string]any{"item_id": item["id"], "output_index": index, "input": item["input"]})
		default:
			s.emit("response.output_text.done", map[string]any{"item_id": item["id"], "output_index": index, "content_index": 0, "text": s.text})
			s.emit("response.content_part.done", map[string]any{"item_id": item["id"], "output_index": index, "content_index": 0, "part": item["content"].([]any)[0]})
		}
		s.emit("response.output_item.done", map[string]any{"output_index": index, "item": item})
	}
}
