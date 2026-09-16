package brickrouting

import (
	"context"
	"github.com/regolo-ai/brick-SR1/apps/router/src/spatial-router/pkg/config"
	"testing"
)

func TestCodexClassifierNeverUsesSessionCredential(t *testing.T) {
	cfg := &config.RouterConfig{CodexRouter: config.CodexRouterConfig{Enabled: true}}
	client := newComplexityClient(cfg, config.SkillRouterComplexityModelConfig{BaseURL: "https://api.regolo.ai", Protocol: "openai", BearerToken: "classifier-secret", UseClientKey: true})
	if client.useClientKey || client.bearerToken != "classifier-secret" {
		t.Fatal("classifier did not isolate its configured credential")
	}
	// A missing classifier credential remains missing even with a session key.
	missing := newComplexityClient(cfg, config.SkillRouterComplexityModelConfig{BaseURL: "https://api.regolo.ai", Protocol: "openai"})
	if missing.useClientKey || missing.credentialErr == nil {
		t.Fatal("missing classifier key accepted")
	}
	label, _ := missing.Classify(config.WithClientAPIKey(context.Background(), "codex-secret"), "classify this")
	if label != "medium" {
		t.Fatal("unexpected fallback")
	}
}
