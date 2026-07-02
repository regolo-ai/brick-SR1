package config

import "testing"

func TestAnthropicPassthroughResolve(t *testing.T) {
	cfg := &AnthropicPassthroughConfig{}
	if got := cfg.Resolve("complexity:easy"); got != "claude-haiku-4-5" {
		t.Fatalf("default easy: %q", got)
	}
	if got := cfg.Resolve("medium"); got != "claude-sonnet-4-6" {
		t.Fatalf("default medium: %q", got)
	}
	if got := cfg.Resolve("hard"); got != "claude-opus-4-8" {
		t.Fatalf("default hard: %q", got)
	}
	if got := cfg.Resolve("unknown"); got != "claude-sonnet-4-6" {
		t.Fatalf("unknown should fall back to medium: %q", got)
	}

	cfg.ModelMap.Easy = "haiku-custom"
	cfg.ModelMap.Hard = "opus-custom"
	if got := cfg.Resolve("complexity:easy"); got != "haiku-custom" {
		t.Fatalf("custom easy: %q", got)
	}
	if got := cfg.Resolve("complexity:hard"); got != "opus-custom" {
		t.Fatalf("custom hard: %q", got)
	}
}

func TestAnthropicPassthroughEffectiveURL(t *testing.T) {
	cfg := &AnthropicPassthroughConfig{}
	if got := cfg.EffectiveUpstreamURL(); got != "https://api.anthropic.com" {
		t.Fatalf("default url: %q", got)
	}
	cfg.UpstreamURL = "http://localhost:9999/"
	if got := cfg.EffectiveUpstreamURL(); got != "http://localhost:9999" {
		t.Fatalf("custom url trim: %q", got)
	}
}

func TestModelAndThinkingRoutingDefaults(t *testing.T) {
	cfg := &AnthropicPassthroughConfig{}
	// Absent keys default to on (historic behavior).
	if !cfg.ModelRoutingEnabled() {
		t.Fatalf("nil UseModelRouting should default to true")
	}
	if !cfg.ThinkingRoutingEnabled() {
		t.Fatalf("nil UseThinkingRouting should default to true")
	}

	off := false
	on := true
	cfg.UseModelRouting = &off
	cfg.UseThinkingRouting = &on
	if cfg.ModelRoutingEnabled() {
		t.Fatalf("explicit false UseModelRouting should disable model routing")
	}
	if !cfg.ThinkingRoutingEnabled() {
		t.Fatalf("explicit true UseThinkingRouting should enable thinking routing")
	}
}

func TestEffectiveFixedModel(t *testing.T) {
	cfg := &AnthropicPassthroughConfig{}
	// Empty falls back to Sonnet.
	if got := cfg.EffectiveFixedModel(); got != "claude-sonnet-4-6" {
		t.Fatalf("empty fixed_model fallback: %q", got)
	}
	cfg.FixedModel = "claude-opus-4-8"
	if got := cfg.EffectiveFixedModel(); got != "claude-opus-4-8" {
		t.Fatalf("configured fixed_model: %q", got)
	}
}
