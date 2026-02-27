package config

import (
	"fmt"
	"net/url"
	"os"
	"regexp"
)

// MyModel-specific configuration extensions.
// These are added alongside the existing vLLM SR configuration to support
// the HTTP proxy mode (replacing Envoy).

// MyModelConfig holds the virtual model identity exposed to clients.
type MyModelConfig struct {
	Name        string `yaml:"name"`
	Description string `yaml:"description,omitempty"`
}

// ProviderConfig represents an LLM provider backend.
type ProviderConfig struct {
	Type    string `yaml:"type"`     // "openai", "anthropic", "vllm", etc.
	BaseURL string `yaml:"base_url"` // e.g., "https://api.openai.com"
	APIKey  string `yaml:"api_key"`  // supports ${ENV_VAR} syntax
}

// ModalityRoutesConfig holds routing rules for non-text modalities.
type ModalityRoutesConfig struct {
	Image *ModalityRoute `yaml:"image,omitempty"`
	Audio *ModalityRoute `yaml:"audio,omitempty"`
	Video *ModalityRoute `yaml:"video,omitempty"`
}

// ModalityRoute maps a modality to a provider and model.
type ModalityRoute struct {
	Provider string `yaml:"provider"`
	Model    string `yaml:"model"`
}

// TextRoute defines a semantic routing rule for text requests.
type TextRoute struct {
	Name     string            `yaml:"name"`
	Priority int               `yaml:"priority,omitempty"`
	Signals  map[string]string `yaml:"signals,omitempty"` // signal_type -> value/pattern
	Provider string            `yaml:"provider"`
	Model    string            `yaml:"model"`
}

// BrickConfig holds configuration for the "brick" virtual model gateway.
// When enabled, the proxy exposes a single "brick" model that detects modality
// (text/audio/image), preprocesses non-text content, and routes through the
// semantic pipeline.
type BrickConfig struct {
	Enabled       bool   `yaml:"enabled,omitempty"`
	STTModel      string `yaml:"stt_model,omitempty"`      // e.g., "faster-whisper-large-v3"
	STTEndpoint   string `yaml:"stt_endpoint,omitempty"`   // e.g., "https://api.regolo.ai/v1/audio/transcriptions"
	OCRModel      string `yaml:"ocr_model,omitempty"`      // e.g., "deepseek-ocr"
	OCREndpoint   string `yaml:"ocr_endpoint,omitempty"`   // e.g., "https://api.regolo.ai/v1/chat/completions"
	VisionModel   string `yaml:"vision_model,omitempty"`   // e.g., "qwen3-vl-32b"
	VisionEndpoint string `yaml:"vision_endpoint,omitempty"` // e.g., "https://api.regolo.ai/v1/chat/completions"
	OCRMinTextLen int    `yaml:"ocr_min_text_length,omitempty"`
}

// GetOCRMinTextLen returns the minimum OCR text length to consider valid, defaulting to 10.
func (b *BrickConfig) GetOCRMinTextLen() int {
	if b.OCRMinTextLen > 0 {
		return b.OCRMinTextLen
	}
	return 10
}

// Validate checks that all required fields are set when brick is enabled.
// Should be called at startup to fail fast on misconfiguration.
func (b *BrickConfig) Validate() error {
	if !b.Enabled {
		return nil
	}

	checks := []struct {
		field, name string
	}{
		{b.VisionModel, "brick.vision_model"},
		{b.VisionEndpoint, "brick.vision_endpoint"},
		{b.STTModel, "brick.stt_model"},
		{b.STTEndpoint, "brick.stt_endpoint"},
		{b.OCRModel, "brick.ocr_model"},
		{b.OCREndpoint, "brick.ocr_endpoint"},
	}
	for _, c := range checks {
		if c.field == "" {
			return fmt.Errorf("brick enabled but %s is not configured", c.name)
		}
	}

	// Validate that endpoints are parseable URLs
	endpoints := []struct {
		value, name string
	}{
		{b.VisionEndpoint, "brick.vision_endpoint"},
		{b.STTEndpoint, "brick.stt_endpoint"},
		{b.OCREndpoint, "brick.ocr_endpoint"},
	}
	for _, ep := range endpoints {
		u, err := url.Parse(ep.value)
		if err != nil {
			return fmt.Errorf("%s is not a valid URL: %w", ep.name, err)
		}
		if u.Host == "" {
			return fmt.Errorf("%s has no host: %q", ep.name, ep.value)
		}
	}

	return nil
}

// MyModelExtension holds all MyModel-specific config fields.
// These are embedded into the main RouterConfig.
type MyModelExtension struct {
	Model          MyModelConfig                `yaml:"model,omitempty"`
	Providers      map[string]*ProviderConfig   `yaml:"providers,omitempty"`
	ModalityRoutes ModalityRoutesConfig         `yaml:"modality_routes,omitempty"`
	TextRoutes     []TextRoute                  `yaml:"text_routes,omitempty"`
	ServerPort     int                          `yaml:"server_port,omitempty"`
	Brick          BrickConfig                  `yaml:"brick,omitempty"`
}

// envVarPattern matches ${VAR_NAME} patterns for environment variable resolution.
var envVarPattern = regexp.MustCompile(`\$\{([^}]+)\}`)

// ResolveEnvVars replaces ${VAR} patterns with their environment variable values.
func ResolveEnvVars(s string) string {
	return envVarPattern.ReplaceAllStringFunc(s, func(match string) string {
		// Extract the variable name from ${VAR_NAME}
		varName := match[2 : len(match)-1]
		if val, ok := os.LookupEnv(varName); ok {
			return val
		}
		return match // leave unresolved if env var not set
	})
}

// ResolveProviderKeys resolves environment variables in all provider API keys.
func (ext *MyModelExtension) ResolveProviderKeys() {
	for _, p := range ext.Providers {
		if p != nil {
			p.APIKey = ResolveEnvVars(p.APIKey)
		}
	}
}

// GetServerPort returns the configured port or the default (8000).
func (ext *MyModelExtension) GetServerPort() int {
	if ext.ServerPort > 0 {
		return ext.ServerPort
	}
	return 8000
}
