package multimodal

import (
	"context"
	"io"
	"net/http"
	"strings"
	"testing"

	"github.com/regolo-ai/brick-SR1/apps/router/src/spatial-router/pkg/config"
)

type authTestTransport func(*http.Request) (*http.Response, error)

func (f authTestTransport) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func TestRegoloPreprocessingUsesClientKey(t *testing.T) {
	for _, operation := range []string{"ocr", "transcription"} {
		for _, key := range []string{"client-key", "second-user-key", "", "${REGOLO_API_KEY}"} {
			t.Run(operation+"/"+key, func(t *testing.T) {
				t.Setenv("REGOLO_API_KEY", "server-key-must-not-be-used")
				original := http.DefaultTransport
				t.Cleanup(func() { http.DefaultTransport = original })
				calls := 0
				http.DefaultTransport = authTestTransport(func(req *http.Request) (*http.Response, error) {
					calls++
					if req.Header.Get("Authorization") != "Bearer "+key {
						t.Error("preprocessor did not receive the current client credential")
					}
					body := `{"text":"transcribed","choices":[{"message":{"content":"recognized"}}]}`
					return &http.Response{StatusCode: http.StatusOK, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(body))}, nil
				})
				cfg := &config.BrickConfig{
					OCREndpoint: "https://api.regolo.ai/v1/chat/completions",
					STTEndpoint: "https://api.regolo.ai/v1/audio/transcriptions",
				}
				var err error
				if operation == "ocr" {
					_, err = OCRImage(context.Background(), "data:image/png;base64,aGVsbG8=", cfg, key)
				} else {
					_, err = TranscribeAudio(context.Background(), "aGVsbG8=", cfg, key)
				}
				if key == "client-key" || key == "second-user-key" {
					if err != nil || calls != 1 {
						t.Fatalf("expected one authenticated preprocessing call: calls=%d err=%v", calls, err)
					}
				} else if err == nil || calls != 0 {
					t.Fatal("invalid client credential must prevent preprocessing requests")
				}
			})
		}
	}
}
