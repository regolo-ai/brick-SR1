package proxy

import (
	"encoding/json"
)

// adaptForRegoloAPI translates vLLM-specific request body fields into
// OpenAI-compatible format for the Regolo API.
//
// The vLLM Semantic Router sets reasoning parameters via chat_template_kwargs
// (e.g., {"chat_template_kwargs": {"thinking": true}}), which is the correct
// format for local vLLM inference servers. However, OpenAI-compatible APIs
// expect these as top-level fields (e.g., {"thinking": true}).
//
// This function:
//  1. Extracts "thinking" or "enable_thinking" from chat_template_kwargs → sets top-level "thinking"
//  2. Extracts "reasoning_effort" from chat_template_kwargs → sets top-level "reasoning_effort"
//  3. Removes the chat_template_kwargs field entirely
//  4. Preserves all other fields unchanged
func adaptForRegoloAPI(body []byte) []byte {
	var m map[string]interface{}
	if err := json.Unmarshal(body, &m); err != nil {
		return body
	}

	kwargs, ok := m["chat_template_kwargs"].(map[string]interface{})
	if !ok {
		// No chat_template_kwargs present — nothing to adapt
		return body
	}

	// Move "thinking" → top-level "thinking"
	if v, ok := kwargs["thinking"]; ok {
		m["thinking"] = v
	}

	// Move "enable_thinking" (qwen3 format) → top-level "thinking"
	if v, ok := kwargs["enable_thinking"]; ok {
		m["thinking"] = v
	}

	// Move "reasoning_effort" → top-level "reasoning_effort"
	if v, ok := kwargs["reasoning_effort"]; ok {
		m["reasoning_effort"] = v
	}

	// Remove the vLLM-specific field
	delete(m, "chat_template_kwargs")

	result, err := json.Marshal(m)
	if err != nil {
		return body
	}
	return result
}
