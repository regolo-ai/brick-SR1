package config

import "testing"

func codexConfig() *RouterConfig {
	c := &RouterConfig{}
	c.ModelConfig = map[string]ModelParams{"m": {PreferredEndpoints: []string{"endpoint"}}}
	c.ProviderEndpoints = []ProviderEndpoint{{Name: "endpoint", ProviderProfileName: "external"}}
	c.ProviderProfiles = map[string]ProviderProfile{"external": {BaseURL: "https://example.com/v1", Protocol: "responses", AuthSource: "provider_env", APIKeyEnv: "EXTERNAL_KEY"}}
	return c
}
func TestCodexDestination(t *testing.T) {
	c := codexConfig()
	d, err := c.ResolveCodexDestination("m", "responses")
	if err != nil || d.URL != "https://example.com/v1/responses" {
		t.Fatalf("%+v %v", d, err)
	}
	p := c.ProviderProfiles["external"]
	p.BaseURL = d.URL
	c.ProviderProfiles["external"] = p
	d, err = c.ResolveCodexDestination("m", "responses")
	if err != nil || d.URL != "https://example.com/v1/responses" {
		t.Fatal(d, err)
	}
	p.AuthSource = "codex_request"
	c.ProviderProfiles["external"] = p
	if _, err = c.ResolveCodexDestination("m", "responses"); err == nil {
		t.Fatal("accepted Codex auth on external origin")
	}
}
func TestCodexRejectsAmbiguity(t *testing.T) {
	c := codexConfig()
	c.SkillRouter.Models = []SkillRouterModelConfig{{Model: "m", BaseURL: "https://wrong.example/v1"}}
	if _, err := c.ResolveCodexDestination("m", "responses"); err == nil {
		t.Fatal("accepted conflicting inline destination")
	}
	if _, err := c.ResolveCodexDestination("unknown", "responses"); err == nil {
		t.Fatal("unknown model fell back")
	}
	c = codexConfig()
	if _, err := c.ResolveCodexDestination("m", "compact"); err == nil {
		t.Fatal("accepted unsupported compaction")
	}
}
func TestCodexSubscriptionAllowlist(t *testing.T) {
	c := codexConfig()
	c.ProviderEndpoints[0].ProviderProfileName = "openai-codex"
	c.ProviderProfiles = map[string]ProviderProfile{"openai-codex": {BaseURL: "https://chatgpt.com/backend-api/codex", Protocol: "responses", AuthSource: "codex_request", CompactPath: "responses/compact"}}
	for _, operation := range []string{"responses", "compact"} {
		if _, err := c.ResolveCodexDestination("m", operation); err != nil {
			t.Fatal(err)
		}
	}
	for _, base := range []string{"https://api.openai.com/v1", "https://chatgpt.com.evil/backend-api/codex", "http://chatgpt.com/backend-api/codex", "https://chatgpt.com:443/backend-api/codex", "https://chatgpt.com/backend-api/other"} {
		p := c.ProviderProfiles["openai-codex"]
		p.BaseURL = base
		c.ProviderProfiles["openai-codex"] = p
		if _, err := c.ResolveCodexDestination("m", "responses"); err == nil {
			t.Fatal(base)
		}
	}
}

func TestCodexModelTransportCapabilityOverride(t *testing.T) {
	c := codexConfig()
	p := c.ProviderProfiles["external"]
	p.Capabilities = []string{"function_tools", "images"}
	c.ProviderProfiles["external"] = p
	d, err := c.ResolveCodexDestination("m", "responses")
	if err != nil || len(d.Capabilities) != 2 {
		t.Fatal(d, err)
	}
	m := c.ModelConfig["m"]
	m.TransportCapabilities = []string{"function_tools"}
	c.ModelConfig["m"] = m
	d, err = c.ResolveCodexDestination("m", "responses")
	if err != nil || len(d.Capabilities) != 1 || d.Capabilities[0] != "function_tools" {
		t.Fatal(d, err)
	}
	m.TransportCapabilities = []string{}
	c.ModelConfig["m"] = m
	d, err = c.ResolveCodexDestination("m", "responses")
	if err != nil || len(d.Capabilities) != 0 {
		t.Fatal(d, err)
	}
}
