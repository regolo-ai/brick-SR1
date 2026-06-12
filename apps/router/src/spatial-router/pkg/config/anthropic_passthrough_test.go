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
	if got := cfg.Resolve("hard"); got != "claude-opus-4-7" {
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
