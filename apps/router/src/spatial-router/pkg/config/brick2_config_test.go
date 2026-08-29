package config

import (
	"reflect"
	"sort"
	"strings"
	"testing"
)

func TestParseBrick2RootConfig(t *testing.T) {
	cfg, err := Parse("../../../../config/config.yaml")
	if err != nil {
		t.Fatalf("parse root config: %v", err)
	}
	if !cfg.SkillRouter.Enabled {
		t.Fatal("expected skill_router.enabled=true")
	}
	if len(cfg.SkillRouter.Models) != 3 {
		t.Fatalf("expected 3 skill router models, got %d", len(cfg.SkillRouter.Models))
	}
}

func TestParseRegoloDeploymentConfig(t *testing.T) {
	const path = "../../../../../../deploy/docker-compose/config.regolo.yaml"
	cfg, err := Parse(path)
	if err != nil {
		t.Fatalf("parse Regolo deployment config: %v", err)
	}
	if _, ok := cfg.ProviderProfiles["regolo"]; !ok {
		t.Fatal("expected the Regolo provider profile")
	}
	wantModels := []string{"gemma4-31b", "glm5.2-beta", "mistral-small-4-119b", "qwen3.5-122b", "qwen3.5-9b"}
	gotModels := make([]string, 0, len(cfg.ModelConfig))
	for name, model := range cfg.ModelConfig {
		gotModels = append(gotModels, name)
		if len(model.PreferredEndpoints) != 1 || model.PreferredEndpoints[0] != "regolo" {
			t.Fatalf("model %q must use only the Regolo endpoint: %#v", name, model.PreferredEndpoints)
		}
		if model.AccessKey != "${REGOLO_API_KEY}" {
			t.Fatalf("model %q must resolve its key from REGOLO_API_KEY", name)
		}
	}
	sort.Strings(gotModels)
	if !reflect.DeepEqual(gotModels, wantModels) {
		t.Fatalf("unexpected Regolo deployment model pool: got %v, want %v", gotModels, wantModels)
	}
	if cfg.AnthropicPassthrough.Enabled || strings.Contains(strings.ToLower(cfg.AnthropicPassthrough.UpstreamURL), "anthropic") {
		t.Fatal("Regolo deployment config must not enable Anthropic pass-through")
	}
}

func TestParsePollinationsDeploymentConfig(t *testing.T) {
	const path = "../../../../../../deploy/docker-compose/config.pollinations.yaml"
	cfg, err := Parse(path)
	if err != nil {
		t.Fatalf("parse Pollinations deployment config: %v", err)
	}
	if cfg.Brick.RequiredBearerPrefix != "ag_" {
		t.Fatalf("required bearer prefix = %q, want ag_", cfg.Brick.RequiredBearerPrefix)
	}
	wantModels := []string{"gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.6-terra"}
	gotModels := make([]string, 0, len(cfg.SkillRouter.Models))
	for _, model := range cfg.SkillRouter.Models {
		gotModels = append(gotModels, model.Model)
		if model.BaseURL != "https://gen.pollinations.ai/v1" {
			t.Fatalf("model %q base URL = %q", model.Model, model.BaseURL)
		}
		if model.APIKey != "" || model.APIKeyEnv != "" || model.APIKeyFile != "" {
			t.Fatalf("model %q must use the delegated caller token", model.Model)
		}
	}
	sort.Strings(gotModels)
	if !reflect.DeepEqual(gotModels, wantModels) {
		t.Fatalf("unexpected Pollinations model pool: got %v, want %v", gotModels, wantModels)
	}
}
