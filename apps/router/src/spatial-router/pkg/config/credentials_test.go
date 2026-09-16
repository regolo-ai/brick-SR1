package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestRegoloConfigDoesNotRequireServerSecret(t *testing.T) {
	for _, value := range []string{"", "  \n", "${REGOLO_API_KEY}", "$REGOLO_API_KEY", "prefix-${MISSING}"} {
		t.Run(value, func(t *testing.T) {
			t.Setenv("REGOLO_API_KEY", value)
			if _, err := Parse("../../../../../../examples/regolo.config.yaml"); err != nil {
				t.Fatal("server environment must not affect client-key deployment")
			}
		})
	}
	t.Run("absent", func(t *testing.T) {
		t.Setenv("REGOLO_API_KEY", "temporary")
		if err := os.Unsetenv("REGOLO_API_KEY"); err != nil {
			t.Fatal(err)
		}
		if _, err := Parse("../../../../../../examples/regolo.config.yaml"); err != nil {
			t.Fatal("deployment must load without a server Secret")
		}
	})
}

func TestParseCredentialValidation(t *testing.T) {
	t.Setenv("REGOLO_API_KEY", "server-key")
	t.Setenv("EMPTY_KEY", "")
	for _, fragment := range []string{
		"server_port: secret-literal\n",
		"model_config:\n  model:\n    access_key_env: EMPTY_KEY\n",
		"model_config:\n  model:\n    access_key: secret-literal\n    access_key_env: REGOLO_API_KEY\n",
		"model_config:\n  model:\n    access_key: prefix-${EMPTY_KEY}\n",
		"skill_router:\n  models:\n    - model: model\n      api_key_env: EMPTY_KEY\n",
		"complexity_service:\n  enabled: true\n  bearer_token: ${EMPTY_KEY}\n",
		"skill_router:\n  complexity_model:\n    bearer_token: ${EMPTY_KEY}\n",
	} {
		path := filepath.Join(t.TempDir(), "config.yaml")
		if err := os.WriteFile(path, []byte(fragment), 0o600); err != nil {
			t.Fatal(err)
		}
		_, err := Parse(path)
		if err == nil {
			t.Fatalf("expected invalid credential configuration to fail: %s", fragment)
		}
		if strings.Contains(err.Error(), "secret-literal") || strings.Contains(err.Error(), "server-key") {
			t.Fatal("error exposes credential contents")
		}
	}
}

func TestResolveModelCredential(t *testing.T) {
	t.Setenv("REGOLO_API_KEY", "  server-key\n")
	cfg := &RouterConfig{BackendModels: BackendModels{ModelConfig: map[string]ModelParams{
		"model": {AccessKeyEnv: "REGOLO_API_KEY"},
	}}}
	if got, err := cfg.ResolveModelAccessKey("model"); err != nil || got != "server-key" {
		t.Fatal("expected trimmed Secret value")
	}
	t.Setenv("REGOLO_API_KEY", "${REGOLO_API_KEY}")
	if key, err := cfg.ResolveUpstreamAPIKey("model", "client-key"); err == nil || key != "" {
		t.Fatal("invalid explicit provider source must not fall back to the client")
	}
	if got, err := cfg.ResolveModelAccessKey("model"); err == nil || got != "" {
		t.Fatal("resolver must not return an unresolved credential")
	}
}

func TestComplexityTokenValidation(t *testing.T) {
	t.Setenv("REGOLO_API_KEY", "server-key")
	cfg := &ComplexityServiceConfig{BearerToken: "${REGOLO_API_KEY}"}
	if got, err := cfg.ResolveBearerToken(); err != nil || got != "server-key" {
		t.Fatalf("expected resolved classifier credential: %v", err)
	}
	for _, value := range []string{"", " \n", "${REGOLO_API_KEY}"} {
		t.Setenv("REGOLO_API_KEY", value)
		if _, err := cfg.ResolveBearerToken(); err == nil {
			t.Fatal("expected invalid classifier environment to fail")
		}
		path := filepath.Join(t.TempDir(), "token")
		if err := os.WriteFile(path, []byte(value), 0o600); err != nil {
			t.Fatal(err)
		}
		if _, err := (&ComplexityServiceConfig{BearerTokenFile: path}).ResolveBearerToken(); err == nil {
			t.Fatal("expected invalid classifier token file to fail")
		}
	}
}

func TestCredentialSourceIsIndependentOfEndpointDomain(t *testing.T) {
	for _, url := range []string{"https://api.regolo.ai/v1", "https://other.example/v1"} {
		cfg := &RouterConfig{SkillRouter: SkillRouterConfig{Models: []SkillRouterModelConfig{{Model: "test", BaseURL: url, APIKey: "provider-key"}}}}
		key, err := cfg.ResolveUpstreamAPIKey("test", "caller-key")
		if err != nil || key != "provider-key" {
			t.Fatal("explicit provider credential must win independently of domain")
		}
		cfg.SkillRouter.Models[0].UseClientKey = true
		key, err = cfg.ResolveUpstreamAPIKey("test", "caller-key")
		if err != nil || key != "caller-key" {
			t.Fatal("caller mode must use only the current request")
		}
		if _, err = cfg.ResolveUpstreamAPIKey("test", ""); err == nil {
			t.Fatal("caller mode fell back to provider credential")
		}
		cs := &ComplexityServiceConfig{BaseURL: url, BearerToken: "classifier-key"}
		if cs.UsesClientKey() {
			t.Fatal("domain selected caller authentication")
		}
	}
}
