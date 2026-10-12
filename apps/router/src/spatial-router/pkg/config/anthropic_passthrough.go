package config

import "strings"

// AnthropicPassthroughConfig configures the /v1/messages pass-through endpoint.
// When enabled, Brick exposes a transparent Anthropic-native proxy that selects
// a model using local SystemOne capability vectors and rewrites the `model` field before forwarding upstream
// (typically api.anthropic.com). All other request fields and headers (Authorization,
// anthropic-version, etc.) are forwarded unchanged so the client's own credentials
// and SDK contract are preserved.
type AnthropicPassthroughConfig struct {
	Enabled     bool   `yaml:"enabled"`
	UpstreamURL string `yaml:"upstream_url,omitempty"`

	// RouteSubagents, when true, sends requests that arrive with an explicit
	// native Claude model (haiku/sonnet/opus, typical of Claude Code subagents)
	// through the skill router instead of forwarding them verbatim. The Brick
	// router then picks the model by SystemOne capability vectors, the same way it
	// does for "brick-claude" traffic. Default false preserves the historic
	// passthrough behavior (native models bypass routing). See pkg/proxy/anthropic.go.
	RouteSubagents bool `yaml:"route_subagents,omitempty"`

	// UseModelRouting controls whether brick-routed traffic picks the backend
	// model dynamically (SystemOne) or always uses FixedModel.
	// It is a pointer so an absent key defaults to true (historic behavior:
	// model routing on). When explicitly false, every brick-routed request is
	// sent to FixedModel regardless of the query vector. See ModelRoutingEnabled and
	// pkg/proxy/anthropic.go.
	UseModelRouting *bool `yaml:"use_model_routing,omitempty"`

	// FixedModel is the Anthropic model ID used for every brick-routed request
	// when UseModelRouting is false (e.g. "claude-opus-4-8"). Empty falls back
	// to Sonnet. Ignored when UseModelRouting is true/absent.
	FixedModel string `yaml:"fixed_model,omitempty"`

	// ExtraUsageEnabled signals that the upstream account has the paid
	// "extra-usage" tier required to use the 1M-token context window. When
	// false (default), Brick strips any "context-1m-*" anthropic-beta flag
	// from incoming requests so the call falls back to the standard 200K
	// context window — preventing the upstream "Extra usage is required for
	// 1M context" error. When true, Brick preserves the 1M flag when the
	// request body exceeds Context1MThresholdBytes and uses compatible configured candidates.
	ExtraUsageEnabled bool `yaml:"extra_usage_enabled,omitempty"`

	// Context1MThresholdBytes is the request body size above which the 1M
	// context window is considered necessary. Only consulted when
	// ExtraUsageEnabled is true. Default 600000 (~150K tokens) when zero.
	Context1MThresholdBytes int `yaml:"context_1m_threshold_bytes,omitempty"`

	// ContextWindow, when enabled, feeds the SystemOne classifier the
	// last K conversation turns (user + assistant) instead of only the latest
	// user message, so routing reflects accumulated context rather than a
	// single short follow-up. Default disabled (opt-in). See pkg/proxy/anthropic.go.
	ContextWindow ContextWindowConfig `yaml:"context_window,omitempty"`
}

// ContextWindowConfig controls the context-aware classification input.
type ContextWindowConfig struct {
	Enabled bool `yaml:"enabled,omitempty"`
	// K is the number of trailing conversation turns fed to the classifier.
	// Defaults to 8 when zero (see EffectiveContextWindowK).
	K int `yaml:"k,omitempty"`
}

// EffectiveContextWindowK returns the configured K or the default of 8.
func (c *AnthropicPassthroughConfig) EffectiveContextWindowK() int {
	if c.ContextWindow.K > 0 {
		return c.ContextWindow.K
	}
	return 8
}

// EffectiveUpstreamURL returns UpstreamURL or the Anthropic public default.
func (c *AnthropicPassthroughConfig) EffectiveUpstreamURL() string {
	if c.UpstreamURL != "" {
		return strings.TrimRight(c.UpstreamURL, "/")
	}
	return "https://api.anthropic.com"
}

// EffectiveContext1MThresholdBytes returns the configured threshold or 600000.
func (c *AnthropicPassthroughConfig) EffectiveContext1MThresholdBytes() int {
	if c.Context1MThresholdBytes > 0 {
		return c.Context1MThresholdBytes
	}
	return 600000
}

// ModelRoutingEnabled reports whether dynamic model selection is on. An absent
// (nil) UseModelRouting key defaults to true, preserving the historic behavior
// where Brick always routes the model.
func (c *AnthropicPassthroughConfig) ModelRoutingEnabled() bool {
	return c.UseModelRouting == nil || *c.UseModelRouting
}

// EffectiveFixedModel returns the configured FixedModel or the Sonnet fallback
// when empty. Only meaningful when ModelRoutingEnabled() is false.
func (c *AnthropicPassthroughConfig) EffectiveFixedModel() string {
	if c.FixedModel != "" {
		return c.FixedModel
	}
	return "claude-sonnet-4-6"
}
