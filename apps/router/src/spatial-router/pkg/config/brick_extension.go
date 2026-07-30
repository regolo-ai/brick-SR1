package config

import (
	"fmt"
	"net/url"
	"os"
	"regexp"
)

// Brick-specific configuration extensions for Brick proxy mode.

// VirtualModelConfig holds the virtual model identity exposed to clients.
type VirtualModelConfig struct {
	Name        string `yaml:"name"`
	Description string `yaml:"description,omitempty"`
}

// ProviderConfig represents an LLM provider backend.
type ProviderConfig struct {
	Type    string `yaml:"type"`     // "openai_compatible", "openai", "anthropic", etc.
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

// TextRoute defines a spatial routing rule for text requests.
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
	Enabled         bool                `yaml:"enabled,omitempty"`
	UseModelRouting *bool               `yaml:"use_model_routing,omitempty"`
	FixedModel      string              `yaml:"fixed_model,omitempty"`
	ContextWindow   ContextWindowConfig `yaml:"context_window,omitempty"`
	STTModel        string              `yaml:"stt_model,omitempty"`       // e.g., "faster-whisper-large-v3"
	STTEndpoint     string              `yaml:"stt_endpoint,omitempty"`    // e.g., "https://api.regolo.ai/v1/audio/transcriptions"
	OCRModel        string              `yaml:"ocr_model,omitempty"`       // e.g., "deepseek-ocr"
	OCREndpoint     string              `yaml:"ocr_endpoint,omitempty"`    // e.g., "https://api.regolo.ai/v1/chat/completions"
	VisionModel     string              `yaml:"vision_model,omitempty"`    // e.g., "qwen3-vl-32b"
	VisionEndpoint  string              `yaml:"vision_endpoint,omitempty"` // e.g., "https://api.regolo.ai/v1/chat/completions"
	OCRMinTextLen   int                 `yaml:"ocr_min_text_length,omitempty"`

	// RoutingMode mirrors AnthropicPassthroughConfig.RoutingMode for the Codex
	// (OpenAI-compatible) path. "" defaults to smartsqueeze.
	// routing. See EffectiveRoutingMode. Note: the Codex forwarders do not report
	// Anthropic prompt-cache tokens, so sticky economics are weaker here than on
	// the Claude path; the toggle exists for parity and shadow-mode B.
	RoutingMode       string  `yaml:"routing_mode,omitempty"`
	StickyTTLSeconds  int     `yaml:"sticky_ttl_seconds,omitempty"`
	StickyScoreMargin float64 `yaml:"sticky_score_margin,omitempty"`
}

// GetOCRMinTextLen returns the minimum OCR text length to consider valid, defaulting to 10.
func (b *BrickConfig) GetOCRMinTextLen() int {
	if b.OCRMinTextLen > 0 {
		return b.OCRMinTextLen
	}
	return 10
}

// ModelRoutingEnabled reports whether dynamic model selection is on. An absent
// key defaults to true so existing configs keep routing dynamically.
func (b *BrickConfig) ModelRoutingEnabled() bool {
	return b.UseModelRouting == nil || *b.UseModelRouting
}

// EffectiveFixedModel returns the configured fixed model or a safe default.
func (b *BrickConfig) EffectiveFixedModel(defaultModel string) string {
	if b.FixedModel != "" {
		return b.FixedModel
	}
	if defaultModel != "" {
		return defaultModel
	}
	return "gpt-5.4"
}

// EffectiveContextWindowK returns the configured K or the default of 8.
func (b *BrickConfig) EffectiveContextWindowK() int {
	if b.ContextWindow.K > 0 {
		return b.ContextWindow.K
	}
	return 8
}

// EffectiveRoutingMode returns a validated routing mode, defaulting to
// smartsqueeze for Codex profiles.
func (b *BrickConfig) EffectiveRoutingMode() string {
	switch b.RoutingMode {
	case RoutingModeSticky, RoutingModeSmartSqueeze, RoutingModeOrchestrator:
		return b.RoutingMode
	case RoutingModeOff:
		return RoutingModeOff
	default:
		return RoutingModeSmartSqueeze
	}
}

// EffectiveStickyTTLSeconds returns the configured sticky-entry TTL or 360s.
func (b *BrickConfig) EffectiveStickyTTLSeconds() int {
	if b.StickyTTLSeconds > 0 {
		return b.StickyTTLSeconds
	}
	return 360
}

// EffectiveStickyScoreMargin returns the configured switch margin or 0.15.
func (b *BrickConfig) EffectiveStickyScoreMargin() float64 {
	if b.StickyScoreMargin > 0 {
		return b.StickyScoreMargin
	}
	return 0.15
}

// Validate checks configured modality providers when brick is enabled. Text-only
// Codex routing does not require OCR/STT/Vision settings, but each configured
// modality pair must be complete and must point at a valid URL.
func (b *BrickConfig) Validate() error {
	if !b.Enabled {
		return nil
	}

	checks := []struct {
		model, modelName       string
		endpoint, endpointName string
	}{
		{b.VisionModel, "brick.vision_model", b.VisionEndpoint, "brick.vision_endpoint"},
		{b.STTModel, "brick.stt_model", b.STTEndpoint, "brick.stt_endpoint"},
		{b.OCRModel, "brick.ocr_model", b.OCREndpoint, "brick.ocr_endpoint"},
	}
	for _, c := range checks {
		if c.model == "" && c.endpoint == "" {
			continue
		}
		if c.model == "" {
			return fmt.Errorf("brick enabled but %s is not configured", c.modelName)
		}
		if c.endpoint == "" {
			return fmt.Errorf("brick enabled but %s is not configured", c.endpointName)
		}
		u, err := url.Parse(c.endpoint)
		if err != nil {
			return fmt.Errorf("%s is not a valid URL: %w", c.endpointName, err)
		}
		if u.Host == "" {
			return fmt.Errorf("%s has no host: %q", c.endpointName, c.endpoint)
		}
	}

	return nil
}

// BrickExtension holds all Brick-specific config fields.
// These are embedded into the main RouterConfig.
type BrickExtension struct {
	Model                VirtualModelConfig         `yaml:"model,omitempty"`
	Providers            map[string]*ProviderConfig `yaml:"providers,omitempty"`
	ModalityRoutes       ModalityRoutesConfig       `yaml:"modality_routes,omitempty"`
	TextRoutes           []TextRoute                `yaml:"text_routes,omitempty"`
	ServerPort           int                        `yaml:"server_port,omitempty"`
	Brick                BrickConfig                `yaml:"brick,omitempty"`
	AnthropicPassthrough AnthropicPassthroughConfig `yaml:"anthropic_passthrough,omitempty"`
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
func (ext *BrickExtension) ResolveProviderKeys() {
	for _, p := range ext.Providers {
		if p != nil {
			p.APIKey = ResolveEnvVars(p.APIKey)
		}
	}
}

// GetServerPort returns the configured port or the default (8000).
func (ext *BrickExtension) GetServerPort() int {
	if ext.ServerPort > 0 {
		return ext.ServerPort
	}
	return 8000
}
