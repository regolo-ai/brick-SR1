package config

import "strings"

// AnthropicPassthroughConfig configures the /v1/messages pass-through endpoint.
// When enabled, Brick exposes a transparent Anthropic-native proxy that classifies
// prompt difficulty and rewrites only the `model` field before forwarding upstream
// (typically api.anthropic.com). All other request fields and headers (Authorization,
// anthropic-version, etc.) are forwarded unchanged so the client's own credentials
// and SDK contract are preserved.
type AnthropicPassthroughConfig struct {
	Enabled     bool                         `yaml:"enabled"`
	UpstreamURL string                       `yaml:"upstream_url,omitempty"`
	ModelMap    AnthropicPassthroughModelMap `yaml:"model_map,omitempty"`

	// ExtraUsageEnabled signals that the upstream account has the paid
	// "extra-usage" tier required to use the 1M-token context window. When
	// false (default), Brick strips any "context-1m-*" anthropic-beta flag
	// from incoming requests so the call falls back to the standard 200K
	// context window — preventing the upstream "Extra usage is required for
	// 1M context" error. When true, Brick preserves the 1M flag when the
	// request body exceeds Context1MThresholdBytes and uses the
	// ModelMap1M mapping so the chosen model actually supports 1M context
	// (Haiku does not).
	ExtraUsageEnabled bool `yaml:"extra_usage_enabled,omitempty"`

	// Context1MThresholdBytes is the request body size above which the 1M
	// context window is considered necessary. Only consulted when
	// ExtraUsageEnabled is true. Default 600000 (~150K tokens) when zero.
	Context1MThresholdBytes int `yaml:"context_1m_threshold_bytes,omitempty"`

	// ModelMap1M maps complexity → model when the 1M context window is in
	// use. Haiku has no 1M variant so easy should map to Sonnet 1M.
	ModelMap1M AnthropicPassthroughModelMap `yaml:"model_map_1m,omitempty"`
}

// AnthropicPassthroughModelMap maps complexity labels to Anthropic model IDs.
type AnthropicPassthroughModelMap struct {
	Easy   string `yaml:"easy,omitempty"`
	Medium string `yaml:"medium,omitempty"`
	Hard   string `yaml:"hard,omitempty"`
}

// EffectiveUpstreamURL returns UpstreamURL or the Anthropic public default.
func (c *AnthropicPassthroughConfig) EffectiveUpstreamURL() string {
	if c.UpstreamURL != "" {
		return strings.TrimRight(c.UpstreamURL, "/")
	}
	return "https://api.anthropic.com"
}

// Resolve maps a complexity label (e.g. "complexity:hard" or bare "hard") to a
// Anthropic model ID. Falls back to medium model for unknown labels.
func (c *AnthropicPassthroughConfig) Resolve(label string) string {
	return resolveFromMap(label, c.ModelMap, "claude-haiku-4-5", "claude-sonnet-4-6", "claude-opus-4-7")
}

// Resolve1M maps a complexity label to a model that supports the 1M-token
// context window. Defaults upgrade easy → Sonnet 1M (Haiku has no 1M variant).
func (c *AnthropicPassthroughConfig) Resolve1M(label string) string {
	return resolveFromMap(label, c.ModelMap1M, "claude-sonnet-4-6", "claude-sonnet-4-6", "claude-opus-4-7")
}

// EffectiveContext1MThresholdBytes returns the configured threshold or 600000.
func (c *AnthropicPassthroughConfig) EffectiveContext1MThresholdBytes() int {
	if c.Context1MThresholdBytes > 0 {
		return c.Context1MThresholdBytes
	}
	return 600000
}

func resolveFromMap(label string, m AnthropicPassthroughModelMap, easyDefault, mediumDefault, hardDefault string) string {
	bare := strings.TrimPrefix(label, "complexity:")
	switch bare {
	case "easy":
		if m.Easy != "" {
			return m.Easy
		}
		return easyDefault
	case "hard":
		if m.Hard != "" {
			return m.Hard
		}
		return hardDefault
	default:
		if m.Medium != "" {
			return m.Medium
		}
		return mediumDefault
	}
}
