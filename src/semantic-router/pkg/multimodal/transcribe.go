package multimodal

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"time"

	"github.com/vllm-project/semantic-router/src/semantic-router/pkg/config"
)

// maxAudioSize is the maximum allowed decoded audio size (25 MB).
// Prevents OOM from oversized audio payloads.
const maxAudioSize = 25 << 20

// TranscribeAudio sends base64-encoded audio to the Whisper STT endpoint
// and returns the transcribed text.
func TranscribeAudio(ctx context.Context, audioBase64 string, cfg *config.BrickConfig, apiKey string) (string, error) {
	// Reject oversized base64 input before decoding (base64 expands ~33%)
	if len(audioBase64) > maxAudioSize*2 {
		return "", fmt.Errorf("audio data too large (max %d bytes decoded)", maxAudioSize)
	}

	// Decode base64 audio
	audioBytes, err := base64.StdEncoding.DecodeString(audioBase64)
	if err != nil {
		return "", fmt.Errorf("decoding audio base64: %w", err)
	}

	if len(audioBytes) > maxAudioSize {
		return "", fmt.Errorf("decoded audio too large: %d bytes (max %d)", len(audioBytes), maxAudioSize)
	}

	// Build multipart form body (Whisper API expects file upload)
	var buf bytes.Buffer
	writer := multipart.NewWriter(&buf)

	// Add audio file part
	filePart, err := writer.CreateFormFile("file", "audio.wav")
	if err != nil {
		return "", fmt.Errorf("creating form file: %w", err)
	}
	if _, err := filePart.Write(audioBytes); err != nil {
		return "", fmt.Errorf("writing audio data: %w", err)
	}

	// Add model field
	if err := writer.WriteField("model", cfg.STTModel); err != nil {
		return "", fmt.Errorf("writing model field: %w", err)
	}

	if err := writer.Close(); err != nil {
		return "", fmt.Errorf("closing multipart writer: %w", err)
	}

	// Create HTTP request
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, cfg.STTEndpoint, &buf)
	if err != nil {
		return "", fmt.Errorf("creating transcription request: %w", err)
	}
	req.Header.Set("Content-Type", writer.FormDataContentType())
	if apiKey != "" {
		req.Header.Set("Authorization", "Bearer "+apiKey)
	}

	client := &http.Client{Timeout: 2 * time.Minute}
	resp, err := client.Do(req)
	if err != nil {
		return "", fmt.Errorf("transcription request failed: %w", err)
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", fmt.Errorf("reading transcription response: %w", err)
	}

	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("transcription API returned %d: %s", resp.StatusCode, string(respBody))
	}

	// Parse Whisper response: {"text": "..."}
	var result struct {
		Text string `json:"text"`
	}
	if err := json.Unmarshal(respBody, &result); err != nil {
		return "", fmt.Errorf("parsing transcription response: %w", err)
	}

	return result.Text, nil
}
