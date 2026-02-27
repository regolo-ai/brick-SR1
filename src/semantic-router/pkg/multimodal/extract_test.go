package multimodal

import (
	"encoding/json"
	"testing"
)

func TestDetectModality(t *testing.T) {
	tests := []struct {
		name      string
		body      string
		wantText  bool
		wantImage bool
		wantAudio bool
	}{
		{
			name:      "text only - string content",
			body:      `{"messages":[{"role":"user","content":"hello world"}]}`,
			wantText:  true,
			wantImage: false,
			wantAudio: false,
		},
		{
			name:      "text only - array content",
			body:      `{"messages":[{"role":"user","content":[{"type":"text","text":"hello"}]}]}`,
			wantText:  true,
			wantImage: false,
			wantAudio: false,
		},
		{
			name:      "image only",
			body:      `{"messages":[{"role":"user","content":[{"type":"image_url","image_url":{"url":"https://example.com/img.png"}}]}]}`,
			wantText:  false,
			wantImage: true,
			wantAudio: false,
		},
		{
			name:      "audio only",
			body:      `{"messages":[{"role":"user","content":[{"type":"input_audio","input_audio":{"data":"base64data","format":"wav"}}]}]}`,
			wantText:  false,
			wantImage: false,
			wantAudio: true,
		},
		{
			name:      "text + image",
			body:      `{"messages":[{"role":"user","content":[{"type":"text","text":"describe this"},{"type":"image_url","image_url":{"url":"https://example.com/img.png"}}]}]}`,
			wantText:  true,
			wantImage: true,
			wantAudio: false,
		},
		{
			name:      "text + audio",
			body:      `{"messages":[{"role":"user","content":[{"type":"text","text":"transcribe"},{"type":"input_audio","input_audio":{"data":"audiodata","format":"mp3"}}]}]}`,
			wantText:  true,
			wantImage: false,
			wantAudio: true,
		},
		{
			name:      "all three modalities",
			body:      `{"messages":[{"role":"user","content":[{"type":"text","text":"analyze"},{"type":"image_url","image_url":{"url":"img.png"}},{"type":"input_audio","input_audio":{"data":"audio","format":"wav"}}]}]}`,
			wantText:  true,
			wantImage: true,
			wantAudio: true,
		},
		{
			name:      "system message ignored",
			body:      `{"messages":[{"role":"system","content":"you are a bot"},{"role":"user","content":"hi"}]}`,
			wantText:  true,
			wantImage: false,
			wantAudio: false,
		},
		{
			name:      "assistant message ignored",
			body:      `{"messages":[{"role":"assistant","content":"I said something"},{"role":"user","content":[{"type":"image_url","image_url":{"url":"img.png"}}]}]}`,
			wantText:  false,
			wantImage: true,
			wantAudio: false,
		},
		{
			name:      "empty messages",
			body:      `{"messages":[]}`,
			wantText:  false,
			wantImage: false,
			wantAudio: false,
		},
		{
			name:      "empty user content string",
			body:      `{"messages":[{"role":"user","content":""}]}`,
			wantText:  false,
			wantImage: false,
			wantAudio: false,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			m, err := DetectModality([]byte(tc.body))
			if err != nil {
				t.Fatalf("DetectModality() error: %v", err)
			}
			if m.HasText != tc.wantText {
				t.Errorf("HasText = %v, want %v", m.HasText, tc.wantText)
			}
			if m.HasImage != tc.wantImage {
				t.Errorf("HasImage = %v, want %v", m.HasImage, tc.wantImage)
			}
			if m.HasAudio != tc.wantAudio {
				t.Errorf("HasAudio = %v, want %v", m.HasAudio, tc.wantAudio)
			}
		})
	}
}

func TestDetectModalityInvalidJSON(t *testing.T) {
	_, err := DetectModality([]byte("not json"))
	if err == nil {
		t.Error("expected error for invalid JSON")
	}
}

func TestExtractFromMessages(t *testing.T) {
	tests := []struct {
		name       string
		messages   string // JSON array
		wantTexts  int
		wantImages int
		wantAudios int
	}{
		{
			name:       "string content",
			messages:   `[{"role":"user","content":"hello"}]`,
			wantTexts:  1,
			wantImages: 0,
			wantAudios: 0,
		},
		{
			name:       "array with all types",
			messages:   `[{"role":"user","content":[{"type":"text","text":"hi"},{"type":"image_url","image_url":{"url":"img.png"}},{"type":"input_audio","input_audio":{"data":"aud","format":"wav"}}]}]`,
			wantTexts:  1,
			wantImages: 1,
			wantAudios: 1,
		},
		{
			name:       "multiple user messages",
			messages:   `[{"role":"user","content":"first"},{"role":"user","content":"second"}]`,
			wantTexts:  2,
			wantImages: 0,
			wantAudios: 0,
		},
		{
			name:       "non-user roles excluded",
			messages:   `[{"role":"system","content":"sys"},{"role":"assistant","content":"asst"},{"role":"user","content":"usr"}]`,
			wantTexts:  1,
			wantImages: 0,
			wantAudios: 0,
		},
		{
			name:       "empty text part excluded",
			messages:   `[{"role":"user","content":[{"type":"text","text":""}]}]`,
			wantTexts:  0,
			wantImages: 0,
			wantAudios: 0,
		},
		{
			name:       "empty audio data excluded",
			messages:   `[{"role":"user","content":[{"type":"input_audio","input_audio":{"data":"","format":"wav"}}]}]`,
			wantTexts:  0,
			wantImages: 0,
			wantAudios: 0,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			var messages []interface{}
			if err := json.Unmarshal([]byte(tc.messages), &messages); err != nil {
				t.Fatalf("invalid test messages JSON: %v", err)
			}

			result := ExtractFromMessages(messages)
			if len(result.TextParts) != tc.wantTexts {
				t.Errorf("TextParts count = %d, want %d", len(result.TextParts), tc.wantTexts)
			}
			if len(result.ImageURLs) != tc.wantImages {
				t.Errorf("ImageURLs count = %d, want %d", len(result.ImageURLs), tc.wantImages)
			}
			if len(result.AudioParts) != tc.wantAudios {
				t.Errorf("AudioParts count = %d, want %d", len(result.AudioParts), tc.wantAudios)
			}
		})
	}
}

func TestExtractText(t *testing.T) {
	tests := []struct {
		name     string
		messages string
		want     string
	}{
		{
			name:     "single text",
			messages: `[{"role":"user","content":"hello world"}]`,
			want:     "hello world",
		},
		{
			name:     "multiple texts concatenated",
			messages: `[{"role":"user","content":"first"},{"role":"user","content":"second"}]`,
			want:     "first\nsecond",
		},
		{
			name:     "no user messages",
			messages: `[{"role":"system","content":"sys"}]`,
			want:     "",
		},
		{
			name:     "text from array content",
			messages: `[{"role":"user","content":[{"type":"text","text":"from array"}]}]`,
			want:     "from array",
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			var messages []interface{}
			if err := json.Unmarshal([]byte(tc.messages), &messages); err != nil {
				t.Fatalf("invalid test messages JSON: %v", err)
			}
			got := ExtractText(messages)
			if got != tc.want {
				t.Errorf("ExtractText() = %q, want %q", got, tc.want)
			}
		})
	}
}
