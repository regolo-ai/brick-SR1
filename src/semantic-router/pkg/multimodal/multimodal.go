package multimodal

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"sync"

	"github.com/vllm-project/semantic-router/src/semantic-router/pkg/config"
	"github.com/vllm-project/semantic-router/src/semantic-router/pkg/observability/logging"
)

// PreprocessResult describes how the request should be handled after multimodal preprocessing.
type PreprocessResult struct {
	// RewrittenBody is the modified request body with text-only content (for pipeline routing).
	// Set when the request should go through the standard routing pipeline.
	RewrittenBody []byte

	// DirectModel is set when the request should bypass routing and go directly to a model.
	// For example, image+text goes directly to the vision model.
	DirectModel string

	// DirectEndpoint is the API endpoint for direct forwarding.
	DirectEndpoint string

	// PreserveOriginalBody means the original request body should be forwarded as-is
	// (e.g., image+text where the vision model needs the image_url in the body).
	PreserveOriginalBody bool
}

// Preprocess inspects the request body, detects modality, and performs any needed
// preprocessing (transcription, OCR). Returns a PreprocessResult that tells the
// caller whether to run the pipeline or forward directly.
func Preprocess(ctx context.Context, body []byte, cfg *config.BrickConfig, apiKey string) (*PreprocessResult, error) {
	var req struct {
		Messages []interface{} `json:"messages"`
	}
	if err := json.Unmarshal(body, &req); err != nil {
		return nil, fmt.Errorf("parsing request body: %w", err)
	}

	extracted := ExtractFromMessages(req.Messages)
	modality := Modality{
		HasText:  len(extracted.TextParts) > 0,
		HasImage: len(extracted.ImageURLs) > 0,
		HasAudio: len(extracted.AudioParts) > 0,
	}

	logging.Infof("Brick modality detected: text=%v image=%v audio=%v", modality.HasText, modality.HasImage, modality.HasAudio)

	// image+text (no audio) → forward directly to vision model, preserve original body
	if modality.HasImage && modality.HasText && !modality.HasAudio {
		return &PreprocessResult{
			DirectModel:          cfg.VisionModel,
			DirectEndpoint:       cfg.VisionEndpoint,
			PreserveOriginalBody: true,
		}, nil
	}

	// Concurrent transcription + OCR when both are needed
	var transcribedText string
	var ocrText string
	var transcribeErr, ocrErr error

	needsTranscribe := modality.HasAudio && len(extracted.AudioParts) > 0
	needsOCR := modality.HasImage && len(extracted.ImageURLs) > 0

	if needsTranscribe && needsOCR {
		var wg sync.WaitGroup
		wg.Add(2)
		go func() {
			defer wg.Done()
			transcribedText, transcribeErr = TranscribeAudio(ctx, extracted.AudioParts[0], cfg, apiKey)
		}()
		go func() {
			defer wg.Done()
			ocrText, ocrErr = OCRImage(ctx, extracted.ImageURLs[0], cfg, apiKey)
		}()
		wg.Wait()
	} else if needsTranscribe {
		transcribedText, transcribeErr = TranscribeAudio(ctx, extracted.AudioParts[0], cfg, apiKey)
	} else if needsOCR {
		ocrText, ocrErr = OCRImage(ctx, extracted.ImageURLs[0], cfg, apiKey)
	}

	if transcribeErr != nil {
		return nil, fmt.Errorf("transcription failed: %w", transcribeErr)
	}
	if ocrErr != nil {
		logging.Warnf("OCR failed (will try vision fallback): %v", ocrErr)
	}

	// image-only (no text, no audio): OCR then decide
	if modality.HasImage && !modality.HasText && !modality.HasAudio {
		if ocrErr != nil || len(ocrText) < cfg.GetOCRMinTextLen() {
			// OCR failed or too little text → forward directly to vision model
			return &PreprocessResult{
				DirectModel:          cfg.VisionModel,
				DirectEndpoint:       cfg.VisionEndpoint,
				PreserveOriginalBody: true,
			}, nil
		}
		// OCR succeeded with enough text → route through pipeline
		return &PreprocessResult{
			RewrittenBody: rewriteMessagesAsText(body, ocrText),
		}, nil
	}

	// Build combined text from all sources
	var parts []string
	if transcribedText != "" {
		parts = append(parts, "Audio: "+transcribedText)
	}
	if ocrText != "" && len(ocrText) >= cfg.GetOCRMinTextLen() {
		parts = append(parts, "Image text: "+ocrText)
	}
	if modality.HasText {
		parts = append(parts, "Text: "+strings.Join(extracted.TextParts, "\n"))
	}

	// audio-only
	if modality.HasAudio && !modality.HasText && !modality.HasImage {
		if transcribedText == "" {
			return nil, fmt.Errorf("audio transcription returned empty text")
		}
		return &PreprocessResult{
			RewrittenBody: rewriteMessagesAsText(body, transcribedText),
		}, nil
	}

	// text-only: no preprocessing needed, just pass through
	if modality.HasText && !modality.HasImage && !modality.HasAudio {
		return &PreprocessResult{
			RewrittenBody: body,
		}, nil
	}

	// All remaining mixed cases: combine text and route through pipeline
	combinedText := strings.Join(parts, "\n")
	if combinedText == "" {
		return nil, fmt.Errorf("no content could be extracted from the request")
	}

	return &PreprocessResult{
		RewrittenBody: rewriteMessagesAsText(body, combinedText),
	}, nil
}

// rewriteMessagesAsText replaces user message content with plain text,
// removing any multimodal content parts.
func rewriteMessagesAsText(originalBody []byte, newText string) []byte {
	var raw map[string]interface{}
	if err := json.Unmarshal(originalBody, &raw); err != nil {
		return originalBody
	}

	messages, ok := raw["messages"].([]interface{})
	if !ok {
		return originalBody
	}

	// Find the last user message and replace its content
	for i := len(messages) - 1; i >= 0; i-- {
		msg, ok := messages[i].(map[string]interface{})
		if !ok {
			continue
		}
		if role, _ := msg["role"].(string); role == "user" {
			msg["content"] = newText
			break
		}
	}

	raw["messages"] = messages
	result, err := json.Marshal(raw)
	if err != nil {
		return originalBody
	}
	return result
}
