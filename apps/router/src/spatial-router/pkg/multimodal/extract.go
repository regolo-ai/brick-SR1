package multimodal

import (
	"encoding/json"
	"strings"
)

// Modality represents the combination of content types detected in a request.
type Modality struct {
	HasText  bool
	HasImage bool
	HasAudio bool
}

// ExtractedContent holds text, images, and audio extracted from a message array.
type ExtractedContent struct {
	TextParts  []string // plain text strings
	ImageURLs  []string // image URLs or data URIs
	AudioParts []string // base64-encoded audio data
}

// ExtractFromMessages parses the messages array and extracts all content by type.
func ExtractFromMessages(messages []interface{}) ExtractedContent {
	var result ExtractedContent

	for _, msg := range messages {
		msgMap, ok := msg.(map[string]interface{})
		if !ok {
			continue
		}

		role, _ := msgMap["role"].(string)
		if role != "user" {
			continue
		}

		content := msgMap["content"]
		if content == nil {
			continue
		}

		textParts, images, audio := extractParts(content)
		result.TextParts = append(result.TextParts, textParts...)
		result.ImageURLs = append(result.ImageURLs, images...)
		result.AudioParts = append(result.AudioParts, audio...)
	}

	return result
}

// textParts returns the text strings of one message content value.
func textParts(content interface{}) []string {
	text, _, _ := extractParts(content)
	return text
}

func extractParts(content interface{}) (texts, images, audio []string) {
	// Case 1: content is a plain string
	if textContent, ok := content.(string); ok {
		if textContent != "" {
			texts = append(texts, textContent)
		}
		return texts, nil, nil
	}

	// Case 2: content is an array of parts
	partsRaw, ok := content.([]interface{})
	if !ok {
		return nil, nil, nil
	}

	for _, partRaw := range partsRaw {
		partMap, ok := partRaw.(map[string]interface{})
		if !ok {
			continue
		}

		partType, _ := partMap["type"].(string)
		switch partType {
		case "text":
			if text, ok := partMap["text"].(string); ok && text != "" {
				texts = append(texts, text)
			}
		case "image_url":
			if imgObj, ok := partMap["image_url"].(map[string]interface{}); ok {
				if url, ok := imgObj["url"].(string); ok && url != "" {
					images = append(images, url)
				}
			}
		case "input_audio":
			if audioObj, ok := partMap["input_audio"].(map[string]interface{}); ok {
				if data, ok := audioObj["data"].(string); ok && data != "" {
					audio = append(audio, data)
				}
			}
		}
	}

	return texts, images, audio
}

// ExtractLastUserText returns the text of the final user message only. Strict
// keyword rules use it so a keyword from the system prompt, an earlier turn or
// the assistant cannot force a model.
func ExtractLastUserText(messages []interface{}) string {
	for i := len(messages) - 1; i >= 0; i-- {
		msgMap, ok := messages[i].(map[string]interface{})
		if !ok {
			continue
		}
		if role, _ := msgMap["role"].(string); role != "user" {
			continue
		}
		if parts := textParts(msgMap["content"]); len(parts) > 0 {
			return strings.Join(parts, "\n")
		}
		return ""
	}
	return ""
}

// DetectModality examines the request body and returns the content modality.
func DetectModality(body []byte) (Modality, error) {
	var req struct {
		Messages []interface{} `json:"messages"`
	}
	if err := json.Unmarshal(body, &req); err != nil {
		return Modality{}, err
	}

	extracted := ExtractFromMessages(req.Messages)

	return Modality{
		HasText:  len(extracted.TextParts) > 0,
		HasImage: len(extracted.ImageURLs) > 0,
		HasAudio: len(extracted.AudioParts) > 0,
	}, nil
}

// ExtractText returns a single concatenated text from the request's user messages.
func ExtractText(messages []interface{}) string {
	extracted := ExtractFromMessages(messages)
	if len(extracted.TextParts) == 0 {
		return ""
	}
	result := extracted.TextParts[0]
	for _, t := range extracted.TextParts[1:] {
		result += "\n" + t
	}
	return result
}
