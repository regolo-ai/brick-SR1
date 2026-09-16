package config

import (
	"os"
	"reflect"
	"sort"
	"strings"
	"testing"

	"gopkg.in/yaml.v2"
)

func TestParseBrick2RootConfig(t *testing.T) {
	t.Setenv("REGOLO_API_KEY", "")
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
	t.Setenv("REGOLO_API_KEY", "")
	const path = "../../../../../../examples/regolo.config.yaml"
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var document interface{}
	if err := yaml.Unmarshal(data, &document); err != nil {
		t.Fatal(err)
	}
	var checkTokenLimits func(interface{})
	checkTokenLimits = func(value interface{}) {
		switch value := value.(type) {
		case map[interface{}]interface{}:
			for key, nested := range value {
				if key == "max_tokens" || key == "max_completion_tokens" || key == "max_output_tokens" {
					t.Errorf("deployment must not impose output limit %s", key)
				}
				checkTokenLimits(nested)
			}
		case []interface{}:
			for _, nested := range value {
				checkTokenLimits(nested)
			}
		}
	}
	checkTokenLimits(document)
	cfg, err := Parse(path)
	if err != nil {
		t.Fatalf("parse Regolo deployment config: %v", err)
	}
	if !cfg.Brick.Enabled {
		t.Fatal("Regolo deployment must enable the Brick gateway")
	}
	if _, ok := cfg.ProviderProfiles["regolo"]; !ok {
		t.Fatal("expected the Regolo provider profile")
	}
	if len(cfg.Providers) != 1 || cfg.Providers["regolo"] == nil ||
		cfg.Providers["regolo"].BaseURL != "https://api.regolo.ai/v1" ||
		len(cfg.ProviderProfiles) != 1 || cfg.ProviderProfiles["regolo"].BaseURL != "https://api.regolo.ai/v1" ||
		len(cfg.ProviderEndpoints) != 1 || cfg.ProviderEndpoints[0].ProviderProfileName != "regolo" {
		t.Fatal("deployment must configure only the official Regolo upstream")
	}
	if cfg.AutoModelName != "brick-v1-beta" {
		t.Fatal("Regolo deployment must expose brick-v1-beta")
	}
	if cfg.TrustedProxyHeader != "X-Regolo-User-Key" {
		t.Fatalf("Regolo deployment trusted proxy header = %q", cfg.TrustedProxyHeader)
	}
	if !reflect.DeepEqual(cfg.SkillRouter.CapabilityModel.Labels, []string{"instruction_following", "coding", "math_reasoning", "world_knowledge", "planning_agentic", "creative_synthesis"}) {
		t.Fatal("capability labels must follow the Regolo checkpoint's id2label order")
	}
	wantModels := []string{"glm5.2", "qwen3.5-122b", "qwen3.5-9b"}
	gotModels := make([]string, 0, len(cfg.ModelConfig))
	for name, model := range cfg.ModelConfig {
		gotModels = append(gotModels, name)
		if len(model.PreferredEndpoints) != 1 || model.PreferredEndpoints[0] != "regolo" {
			t.Fatalf("model %q must use only the Regolo endpoint: %#v", name, model.PreferredEndpoints)
		}
		if model.AccessKeyEnv != "" || model.AccessKey != "" {
			t.Fatalf("model %q must use the request credential", name)
		}
	}
	sort.Strings(gotModels)
	if !reflect.DeepEqual(gotModels, wantModels) {
		t.Fatalf("unexpected Regolo deployment model pool: got %v, want %v", gotModels, wantModels)
	}
	gotSkills := make([]string, 0, len(cfg.SkillRouter.Models))
	for _, model := range cfg.SkillRouter.Models {
		gotSkills = append(gotSkills, model.Model)
		if model.BaseURL != "" || model.HasExplicitAPIKeySource() {
			t.Fatal("deployment skill models must inherit Regolo endpoints and caller credentials")
		}
		key, err := cfg.ResolveUpstreamAPIKey(model.Model, "client-key")
		if err != nil || key != "client-key" {
			t.Fatalf("model %q did not use the client credential: %v", model.Model, err)
		}
	}
	sort.Strings(gotSkills)
	if !reflect.DeepEqual(gotSkills, wantModels) {
		t.Fatalf("unexpected skill model pool: %v", gotSkills)
	}
	for _, rule := range cfg.SkillRouter.KeywordRules {
		if rule.Model != "" {
			if _, ok := cfg.ModelConfig[rule.Model]; !ok {
				t.Fatalf("keyword override references model outside pool: %s", rule.Model)
			}
		}
	}
	if _, ok := cfg.ModelConfig[cfg.DefaultModel]; !ok {
		t.Fatal("default model is outside the pool")
	}
	if cfg.AnthropicPassthrough.Enabled || strings.Contains(strings.ToLower(cfg.AnthropicPassthrough.UpstreamURL), "anthropic") {
		t.Fatal("Regolo deployment config must not enable Anthropic pass-through")
	}
}

func TestRegoloClassifierUsesClientKey(t *testing.T) {
	cfg, err := Parse("../../../../../../examples/regolo.config.yaml")
	if err != nil {
		t.Fatal(err)
	}
	if !cfg.ComplexityService.UseClientKey || !cfg.SkillRouter.ComplexityModel.UseClientKey {
		t.Fatal("both classifier blocks must use the current user's key")
	}
	if cfg.ComplexityService.BearerToken != "" || cfg.SkillRouter.ComplexityModel.BearerToken != "" {
		t.Fatal("Regolo profile must not configure a server token")
	}
	if cfg.ComplexityService.BaseURL != "https://api.regolo.ai" ||
		cfg.SkillRouter.ComplexityModel.BaseURL != "https://api.regolo.ai" ||
		cfg.ComplexityService.ModelName != "brick-complexity-pro" ||
		cfg.SkillRouter.ComplexityModel.ModelName != "brick-complexity-pro" {
		t.Fatal("classification must use the hosted Regolo model")
	}
}
