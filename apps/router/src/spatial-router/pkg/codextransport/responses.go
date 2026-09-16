// Package codextransport forwards inference only. It never executes tools or reads session credentials.
package codextransport

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"sort"
	"strings"
)

// Compatible fails closed for features requiring explicit backend support.
// Native Responses fields are preserved verbatim; this view is only for eligibility.
func RequiredCapabilities(body []byte) ([]string, error) {
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(body, &raw); err != nil || raw == nil {
		return nil, fmt.Errorf("invalid Responses request")
	}
	required := map[string]bool{}
	require := func(feature string) error {
		required[feature] = true
		return nil
	}
	for key, feature := range map[string]string{"previous_response_id": "previous_response", "conversation": "previous_response", "context_management": "compaction"} {
		if v, ok := raw[key]; ok && string(v) != "null" {
			_ = require(feature)
		}
	}
	var walk func(any) error
	walk = func(value any) error {
		switch v := value.(type) {
		case []any:
			for _, child := range v {
				if err := walk(child); err != nil {
					return err
				}
			}
		case map[string]any:
			if typ, ok := v["type"].(string); ok {
				feature := ""
				switch typ {
				case "message", "input_text", "output_text", "text":
				case "function", "function_call", "function_call_output":
					feature = "function_tools"
				case "custom", "custom_tool_call", "custom_tool_call_output":
					feature = "custom_tools"
				case "reasoning":
					feature = "opaque_reasoning"
				case "compaction":
					feature = "compaction"
				case "input_image":
					feature = "images"
				case "input_audio", "output_audio":
					feature = "audio"
				case "input_file":
					feature = "files"
				default:
					feature = "item:" + typ
				}
				if feature != "" {
					if err := require(feature); err != nil {
						return err
					}
					if feature == "custom_tools" {
						_ = require("function_tools")
					}
				}
				if typ == "namespace" || typ == "additional_tools" {
					if children, ok := v["tools"]; ok {
						if err := walk(children); err != nil {
							return err
						}
					}
				}
			}
			// Tool schemas and JSON argument/output strings are data, not protocol items.
			for _, key := range []string{"content"} {
				if child, ok := v[key]; ok {
					if err := walk(child); err != nil {
						return err
					}
				}
			}
		}
		return nil
	}
	for _, key := range []string{"input", "tools"} {
		var value any
		if len(raw[key]) > 0 {
			if err := json.Unmarshal(raw[key], &value); err != nil {
				return nil, err
			}
			if err := walk(value); err != nil {
				return nil, err
			}
		}
	}
	result := make([]string, 0, len(required))
	for feature := range required {
		result = append(result, feature)
	}
	sort.Strings(result)
	return result, nil
}

func Compatible(body []byte, capabilities []string) error {
	required, err := RequiredCapabilities(body)
	if err != nil {
		return err
	}
	has := make(map[string]bool, len(capabilities))
	for _, capability := range capabilities {
		has[capability] = true
	}
	missing := make([]string, 0)
	for _, capability := range required {
		if !has[capability] {
			missing = append(missing, capability)
		}
	}
	if len(missing) > 0 {
		return fmt.Errorf("backend is missing transport capabilities: %s", strings.Join(missing, ", "))
	}
	return nil
}

// RoutingText provides a separate bounded view; the forwarded history is untouched.
func RoutingText(body []byte, window int) string {
	var raw map[string]json.RawMessage
	_ = json.Unmarshal(body, &raw)
	var items []json.RawMessage
	if json.Unmarshal(raw["input"], &items) != nil {
		var s string
		_ = json.Unmarshal(raw["input"], &s)
		return s
	}
	if window > 0 && len(items) > window {
		items = items[len(items)-window:]
	}
	parts := make([]string, len(items))
	for i, item := range items {
		parts[i] = string(item)
	}
	return strings.Join(parts, "\n")
}

// Forward uses a fresh header allowlist and no redirects or retries. A failed
// stream is terminated, never converted to response.completed.
func Forward(w http.ResponseWriter, r *http.Request, client *http.Client, endpoint, provider, key string, codexAuth bool, body []byte) {
	req, err := http.NewRequestWithContext(r.Context(), http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		http.Error(w, "invalid upstream request", http.StatusBadGateway)
		return
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "text/event-stream, application/json")
	req.Header.Set("Authorization", "Bearer "+key)
	if codexAuth {
		for _, name := range []string{"Chatgpt-Account-Id", "OpenAI-Beta", "Session_id", "Conversation_id", "Session-Id", "Thread-Id", "X-Client-Request-Id", "X-Codex-Beta-Features", "X-Codex-Window-Id", "User-Agent", "Originator", "Version", "X-Codex-Turn-Metadata"} {
			if value := r.Header.Get(name); value != "" {
				req.Header.Set(name, value)
			}
		}
	}
	isolated := *client
	isolated.CheckRedirect = func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse }
	response, err := isolated.Do(req)
	if err != nil {
		http.Error(w, "upstream transport failed: "+provider, http.StatusBadGateway)
		return
	}
	defer response.Body.Close()
	w.Header().Set("X-Brick-Provider", provider)
	// External authentication errors must not trigger OpenAI session renewal.
	if !codexAuth && (response.StatusCode == 401 || response.StatusCode == 403) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadGateway)
		_ = json.NewEncoder(w).Encode(map[string]any{"error": map[string]any{"type": "provider_authentication_error", "provider": provider, "upstream_status": response.StatusCode}})
		return
	}
	if response.StatusCode >= 300 && response.StatusCode < 400 {
		http.Error(w, "upstream redirect refused: "+provider, http.StatusBadGateway)
		return
	}
	for _, name := range []string{"Content-Type", "Retry-After", "X-Request-Id"} {
		if value := response.Header.Get(name); value != "" {
			w.Header().Set(name, value)
		}
	}
	if codexAuth {
		for _, name := range []string{"WWW-Authenticate"} {
			if value := response.Header.Get(name); value != "" {
				w.Header().Set(name, value)
			}
		}
	}
	w.WriteHeader(response.StatusCode)
	if f, ok := w.(http.Flusher); ok {
		f.Flush()
	}
	buf := make([]byte, 32*1024)
	for {
		n, readErr := response.Body.Read(buf)
		if n > 0 {
			if _, err := w.Write(buf[:n]); err != nil {
				return
			}
			if f, ok := w.(http.Flusher); ok {
				f.Flush()
			}
		}
		if readErr == io.EOF {
			return
		}
		if readErr != nil {
			panic(http.ErrAbortHandler)
		}
	}
}
