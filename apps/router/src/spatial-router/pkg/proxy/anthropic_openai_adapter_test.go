package proxy

import (
	"encoding/json"
	"testing"
)

func TestAnthropicMessagesToOpenAI_Text(t *testing.T) {
	body, streaming, err := anthropicMessagesToOpenAI([]byte(`{
  "model":"brick-claude", "max_tokens":16, "system":"Be concise.",
  "messages":[{"role":"user","content":[{"type":"text","text":"hello"}]}]
}`), "qwen3.5-9b")
	if err != nil {
		t.Fatal(err)
	}
	if streaming {
		t.Fatal("unexpected streaming")
	}
	var got map[string]any
	if err := json.Unmarshal(body, &got); err != nil {
		t.Fatal(err)
	}
	if got["model"] != "qwen3.5-9b" {
		t.Fatalf("model = %v", got["model"])
	}
	messages := got["messages"].([]any)
	if len(messages) != 2 {
		t.Fatalf("messages = %#v", messages)
	}
}

func TestOpenAIToAnthropicMessages(t *testing.T) {
	body, err := openAIToAnthropicMessages([]byte(`{
  "id":"chatcmpl-1", "choices":[{"message":{"content":"OK"},"finish_reason":"stop"}],
  "usage":{"prompt_tokens":3,"completion_tokens":1}
}`), "qwen3.5-9b")
	if err != nil {
		t.Fatal(err)
	}
	var got map[string]any
	if err := json.Unmarshal(body, &got); err != nil {
		t.Fatal(err)
	}
	if got["type"] != "message" || got["model"] != "qwen3.5-9b" {
		t.Fatalf("unexpected envelope %#v", got)
	}
	content := got["content"].([]any)[0].(map[string]any)
	if content["text"] != "OK" {
		t.Fatalf("content = %#v", content)
	}
}
