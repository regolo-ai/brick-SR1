package proxy

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"

	"github.com/regolo-ai/brick-SR1/apps/router/src/spatial-router/pkg/config"
)

// anthropicMessagesToOpenAI translates the text subset of the Messages API
// used by Claude Code to OpenAI-compatible chat completions. Tool-use and
// image blocks are deliberately rejected instead of silently corrupting them.
func anthropicMessagesToOpenAI(body []byte, model string) ([]byte, bool, error) {
	var in struct {
		MaxTokens   int               `json:"max_tokens"`
		Messages    []json.RawMessage `json:"messages"`
		System      json.RawMessage   `json:"system"`
		Stream      bool              `json:"stream"`
		Temperature any               `json:"temperature"`
		TopP        any               `json:"top_p"`
	}
	if err := json.Unmarshal(body, &in); err != nil {
		return nil, false, fmt.Errorf("invalid Anthropic request: %w", err)
	}
	type message struct{ Role, Content string }
	var messages []message
	if len(in.System) > 0 && string(in.System) != "null" {
		text, err := anthropicText(in.System)
		if err != nil {
			return nil, false, fmt.Errorf("system: %w", err)
		}
		if text != "" {
			messages = append(messages, message{Role: "system", Content: text})
		}
	}
	for _, raw := range in.Messages {
		var m struct {
			Role    string          `json:"role"`
			Content json.RawMessage `json:"content"`
		}
		if err := json.Unmarshal(raw, &m); err != nil {
			return nil, false, fmt.Errorf("message: %w", err)
		}
		if m.Role != "user" && m.Role != "assistant" {
			return nil, false, fmt.Errorf("unsupported Anthropic role %q", m.Role)
		}
		text, err := anthropicText(m.Content)
		if err != nil {
			return nil, false, err
		}
		messages = append(messages, message{Role: m.Role, Content: text})
	}
	out := map[string]any{"model": model, "messages": messages, "stream": in.Stream}
	if in.MaxTokens > 0 {
		out["max_tokens"] = in.MaxTokens
	}
	if in.Temperature != nil {
		out["temperature"] = in.Temperature
	}
	if in.TopP != nil {
		out["top_p"] = in.TopP
	}
	encoded, err := json.Marshal(out)
	return encoded, in.Stream, err
}

func anthropicText(raw json.RawMessage) (string, error) {
	var plain string
	if err := json.Unmarshal(raw, &plain); err == nil {
		return plain, nil
	}
	var blocks []struct{ Type, Text string }
	if err := json.Unmarshal(raw, &blocks); err != nil {
		return "", fmt.Errorf("content must be text or text blocks")
	}
	parts := make([]string, 0, len(blocks))
	for _, block := range blocks {
		if block.Type != "text" {
			return "", fmt.Errorf("unsupported Anthropic content block %q", block.Type)
		}
		parts = append(parts, block.Text)
	}
	return strings.Join(parts, ""), nil
}

// openAIToAnthropicMessages maps a non-streaming OpenAI-compatible response
// back to the Messages envelope expected by Claude Code.
func openAIToAnthropicMessages(body []byte, model string) ([]byte, error) {
	var in struct {
		ID      string `json:"id"`
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
			FinishReason string `json:"finish_reason"`
		} `json:"choices"`
		Usage struct {
			PromptTokens     int64 `json:"prompt_tokens"`
			CompletionTokens int64 `json:"completion_tokens"`
		} `json:"usage"`
	}
	if err := json.Unmarshal(body, &in); err != nil {
		return nil, err
	}
	if len(in.Choices) == 0 {
		return nil, fmt.Errorf("OpenAI response has no choices")
	}
	stop := "end_turn"
	if in.Choices[0].FinishReason == "length" {
		stop = "max_tokens"
	}
	return json.Marshal(map[string]any{
		"id": in.ID, "type": "message", "role": "assistant", "model": model,
		"content":     []map[string]string{{"type": "text", "text": in.Choices[0].Message.Content}},
		"stop_reason": stop, "stop_sequence": nil,
		"usage": map[string]int64{"input_tokens": in.Usage.PromptTokens, "output_tokens": in.Usage.CompletionTokens},
	})
}

func (s *Server) forwardAnthropicToOpenAI(
	w http.ResponseWriter, r *http.Request,
	modelCfg *config.SkillRouterModelConfig,
	body []byte, selectedModel, label, effort string,
) {
	translated, streaming, err := anthropicMessagesToOpenAI(body, selectedModel)
	if err != nil {
		writeError(w, http.StatusBadRequest, fmt.Sprintf("cannot translate Anthropic request for %s: %v", selectedModel, err))
		return
	}
	regolo := s.cfg.ModelUsesClientKey(selectedModel)
	clientKey := ""
	if regolo {
		clientKey = config.ClientAPIKey(r.Context())
		if _, err := config.ValidateCredential(clientKey); err != nil {
			writeError(w, http.StatusUnauthorized, "missing or invalid client API key")
			return
		}
	}
	key, err := s.cfg.ResolveUpstreamAPIKey(selectedModel, clientKey)
	if err != nil || key == "" {
		writeError(w, http.StatusBadGateway, fmt.Sprintf("configured credential source is missing for provider-backed model %q", selectedModel))
		return
	}
	url := strings.TrimRight(modelCfg.BaseURL, "/") + "/chat/completions"
	upstream, err := http.NewRequestWithContext(r.Context(), http.MethodPost, url, bytes.NewReader(translated))
	if err != nil {
		writeError(w, http.StatusBadGateway, fmt.Sprintf("building OpenAI-compatible request: %v", err))
		return
	}
	upstream.Header.Set("Content-Type", "application/json")
	upstream.Header.Set("Authorization", "Bearer "+key)
	resp, err := anthropicHTTPClient.Do(upstream)
	if err != nil {
		writeError(w, http.StatusBadGateway, fmt.Sprintf("provider-backed model request failed: %v", err))
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		responseBody, readErr := io.ReadAll(resp.Body)
		if readErr != nil {
			responseBody = []byte("provider error response could not be read")
		}
		w.Header().Set("Content-Type", resp.Header.Get("Content-Type"))
		w.WriteHeader(resp.StatusCode)
		_, _ = w.Write(responseBody)
		return
	}
	if streaming {
		s.streamOpenAIAsAnthropic(w, resp.Body, selectedModel, label, effort)
		return
	}
	responseBody, err := io.ReadAll(resp.Body)
	if err != nil {
		writeError(w, http.StatusBadGateway, fmt.Sprintf("reading provider response: %v", err))
		return
	}
	converted, err := openAIToAnthropicMessages(responseBody, selectedModel)
	if err != nil {
		writeError(w, http.StatusBadGateway, fmt.Sprintf("translating provider response: %v", err))
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("X-Brick-Selected-Model", selectedModel)
	w.Header().Set("X-Brick-Complexity", label)
	if effort != "" {
		w.Header().Set("X-Brick-Effort", effort)
	}
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(converted)
}

// streamOpenAIAsAnthropic performs the text-only SSE translation needed by
// Claude Code's normal streaming path. Unsupported tool/image deltas are not
// synthesized; they remain a deliberate validation error in request parsing.
func (s *Server) streamOpenAIAsAnthropic(w http.ResponseWriter, body io.Reader, model, label, effort string) {
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("X-Brick-Selected-Model", model)
	w.Header().Set("X-Brick-Complexity", label)
	if effort != "" {
		w.Header().Set("X-Brick-Effort", effort)
	}
	flusher, _ := w.(http.Flusher)
	write := func(event string, payload any) {
		encoded, _ := json.Marshal(payload)
		_, _ = fmt.Fprintf(w, "event: %s\ndata: %s\n\n", event, encoded)
		if flusher != nil {
			flusher.Flush()
		}
	}
	write("message_start", map[string]any{"type": "message_start", "message": map[string]any{
		"id": "brick-openai", "type": "message", "role": "assistant", "model": model,
		"content": []any{}, "stop_reason": nil, "stop_sequence": nil,
		"usage": map[string]int{"input_tokens": 0, "output_tokens": 0},
	}})
	write("content_block_start", map[string]any{"type": "content_block_start", "index": 0, "content_block": map[string]string{"type": "text", "text": ""}})
	scanner := bufio.NewScanner(body)
	// Some providers send large reasoning chunks; retain a generous line limit.
	scanner.Buffer(make([]byte, 4*1024), 4*1024*1024)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if !strings.HasPrefix(line, "data:") {
			continue
		}
		data := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
		if data == "[DONE]" {
			break
		}
		var chunk struct {
			Choices []struct {
				Delta struct {
					Content string `json:"content"`
				} `json:"delta"`
			} `json:"choices"`
		}
		if json.Unmarshal([]byte(data), &chunk) != nil || len(chunk.Choices) == 0 {
			continue
		}
		if text := chunk.Choices[0].Delta.Content; text != "" {
			write("content_block_delta", map[string]any{"type": "content_block_delta", "index": 0,
				"delta": map[string]string{"type": "text_delta", "text": text}})
		}
	}
	write("content_block_stop", map[string]any{"type": "content_block_stop", "index": 0})
	write("message_delta", map[string]any{"type": "message_delta", "delta": map[string]string{"stop_reason": "end_turn"}, "usage": map[string]int{"output_tokens": 0}})
	write("message_stop", map[string]string{"type": "message_stop"})
}
