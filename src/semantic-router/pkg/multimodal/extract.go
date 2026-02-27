package multimodal

import (
	"encoding/json"
)

// Modality represents the combination of content types detected in a request.
type Modality struct {
	HasText  bool
	HasImage bool
	HasAudio bool
}

// ContentPart represents a single content part in an OpenAI message.
// content can be a string or an array of parts like:
//
//	{"type": "text", "text": "..."}
//	{"type": "image_url", "image_url": {"url": "..."}}
//	{"type": "input_audio", "input_audio": {"data": "...", "format": "..."}}
type ContentPart struct {
	Type       string                 `json:"type"`
	Text       string                 `json:"text,omitempty"`
	ImageURL   map[string]interface{} `json:"image_url,omitempty"`
	InputAudio map[string]interface{} `json:"input_audio,omitempty"`
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

		// Case 1: content is a plain string
		if textContent, ok := content.(string); ok {
			if textContent != "" {
				result.TextParts = append(result.TextParts, textContent)
			}
			continue
		}

		// Case 2: content is an array of parts
		partsRaw, ok := content.([]interface{})
		if !ok {
			continue
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
					result.TextParts = append(result.TextParts, text)
				}
			case "image_url":
				if imgObj, ok := partMap["image_url"].(map[string]interface{}); ok {
					if url, ok := imgObj["url"].(string); ok && url != "" {
						result.ImageURLs = append(result.ImageURLs, url)
					}
				}
			case "input_audio":
				if audioObj, ok := partMap["input_audio"].(map[string]interface{}); ok {
					if data, ok := audioObj["data"].(string); ok && data != "" {
						result.AudioParts = append(result.AudioParts, data)
					}
				}
			}
		}
	}

	return result
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
