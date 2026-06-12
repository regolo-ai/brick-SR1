package multimodal

import (
	"encoding/json"
	"testing"
)

func TestRewriteMessagesAsText(t *testing.T) {
	tests := []struct {
		name        string
		body        string
		newText     string
		wantContent string // expected content of last user message
	}{
		{
			name:        "replaces string content",
			body:        `{"model":"brick","messages":[{"role":"user","content":"original text"}]}`,
			newText:     "transcribed audio",
			wantContent: "transcribed audio",
		},
		{
			name:        "replaces array content with string",
			body:        `{"model":"brick","messages":[{"role":"user","content":[{"type":"text","text":"hi"},{"type":"image_url","image_url":{"url":"img.png"}}]}]}`,
			newText:     "OCR extracted text",
			wantContent: "OCR extracted text",
		},
		{
			name:        "replaces last user message only",
			body:        `{"model":"brick","messages":[{"role":"user","content":"first"},{"role":"assistant","content":"reply"},{"role":"user","content":"second"}]}`,
			newText:     "replaced",
			wantContent: "replaced",
		},
		{
			name:        "preserves non-user messages",
			body:        `{"model":"brick","messages":[{"role":"system","content":"sys prompt"},{"role":"user","content":"question"}]}`,
			newText:     "new question",
			wantContent: "new question",
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			result := rewriteMessagesAsText([]byte(tc.body), tc.newText)

			var parsed map[string]interface{}
			if err := json.Unmarshal(result, &parsed); err != nil {
				t.Fatalf("result is not valid JSON: %v", err)
			}

			messages, ok := parsed["messages"].([]interface{})
			if !ok {
				t.Fatal("messages field missing or wrong type")
			}

			// Find last user message
			var lastUserContent interface{}
			for i := len(messages) - 1; i >= 0; i-- {
				msg, ok := messages[i].(map[string]interface{})
				if !ok {
					continue
				}
				if role, _ := msg["role"].(string); role == "user" {
					lastUserContent = msg["content"]
					break
				}
			}

			contentStr, ok := lastUserContent.(string)
			if !ok {
				t.Fatalf("last user content is not a string: %T", lastUserContent)
			}
			if contentStr != tc.wantContent {
				t.Errorf("content = %q, want %q", contentStr, tc.wantContent)
			}
		})
	}
}

func TestRewriteMessagesAsTextPreservesModel(t *testing.T) {
	body := `{"model":"brick","stream":true,"messages":[{"role":"user","content":"hi"}]}`
	result := rewriteMessagesAsText([]byte(body), "new text")

	var parsed map[string]interface{}
	if err := json.Unmarshal(result, &parsed); err != nil {
		t.Fatalf("result is not valid JSON: %v", err)
	}

	if parsed["model"] != "brick" {
		t.Errorf("model field changed: got %v", parsed["model"])
	}
	if parsed["stream"] != true {
		t.Errorf("stream field changed: got %v", parsed["stream"])
	}
}

func TestRewriteMessagesAsTextInvalidJSON(t *testing.T) {
	input := []byte("not json")
	result := rewriteMessagesAsText(input, "test")
	if string(result) != string(input) {
		t.Error("expected original body returned for invalid JSON")
	}
}
