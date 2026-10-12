package config

import "testing"

func TestAnthropicPassthroughSettings(t *testing.T) {
	cfg := &AnthropicPassthroughConfig{}
	if cfg.EffectiveUpstreamURL() != "https://api.anthropic.com" || !cfg.ModelRoutingEnabled() || cfg.EffectiveFixedModel() != "claude-sonnet-4-6" {
		t.Fatal("invalid defaults")
	}
	off := false
	cfg.UseModelRouting = &off
	cfg.FixedModel = "custom"
	cfg.UpstreamURL = "http://localhost:8000/"
	if cfg.ModelRoutingEnabled() || cfg.EffectiveFixedModel() != "custom" || cfg.EffectiveUpstreamURL() != "http://localhost:8000" {
		t.Fatal("configured settings ignored")
	}
}
