package config

import (
	"os"
	"path/filepath"
	"testing"

	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"
	"gopkg.in/yaml.v3"
)

func TestConfig(t *testing.T) {
	RegisterFailHandler(Fail)
	RunSpecs(t, "Config Suite")
}

var _ = Describe("Config Package", func() {
	var (
		tempDir    string
		configFile string
	)

	BeforeEach(func() {
		var err error
		tempDir, err = os.MkdirTemp("", "config_test")
		Expect(err).NotTo(HaveOccurred())
		configFile = filepath.Join(tempDir, "config.yaml")
	})

	AfterEach(func() {
		os.RemoveAll(tempDir)
	})

	Describe("Parse", func() {
		Context("with missing config file", func() {
			It("should return an error", func() {
				cfg, err := Parse("/nonexistent/config.yaml")
				Expect(err).To(HaveOccurred())
				Expect(cfg).To(BeNil())
				Expect(err.Error()).To(ContainSubstring("failed to read config file"))
			})
		})

		Context("with observability metrics configuration", func() {
			It("should default to enabled when metrics block is omitted", func() {
				configContent := `
observability: {}
`
				err := os.WriteFile(configFile, []byte(configContent), 0o644)
				Expect(err).NotTo(HaveOccurred())

				cfg, err := Parse(configFile)
				Expect(err).NotTo(HaveOccurred())
				Expect(cfg.Observability.Metrics.Enabled).To(BeNil())
			})

			It("should honor explicit metrics disable flag", func() {
				configContent := `
observability:
  metrics:
    enabled: false
`
				err := os.WriteFile(configFile, []byte(configContent), 0o644)
				Expect(err).NotTo(HaveOccurred())

				cfg, err := Parse(configFile)
				Expect(err).NotTo(HaveOccurred())
				Expect(cfg.Observability.Metrics.Enabled).NotTo(BeNil())
				Expect(*cfg.Observability.Metrics.Enabled).To(BeFalse())
			})

			It("should honor explicit metrics enable flag", func() {
				configContent := `
observability:
  metrics:
    enabled: true
`
				err := os.WriteFile(configFile, []byte(configContent), 0o644)
				Expect(err).NotTo(HaveOccurred())

				cfg, err := Parse(configFile)
				Expect(err).NotTo(HaveOccurred())
				Expect(cfg.Observability.Metrics.Enabled).NotTo(BeNil())
				Expect(*cfg.Observability.Metrics.Enabled).To(BeTrue())
			})
		})

		Context("with invalid YAML syntax", func() {
			BeforeEach(func() {
				invalidYAML := `
bert_model:
  model_id: "test-model"
  invalid: [ unclosed array
`
				err := os.WriteFile(configFile, []byte(invalidYAML), 0o644)
				Expect(err).NotTo(HaveOccurred())
			})

			It("should return a parsing error", func() {
				cfg, err := Parse(configFile)
				Expect(err).To(HaveOccurred())
				Expect(cfg).To(BeNil())
				Expect(err.Error()).To(ContainSubstring("failed to parse config file"))
			})
		})

		Context("with empty config file", func() {
			BeforeEach(func() {
				err := os.WriteFile(configFile, []byte(""), 0o644)
				Expect(err).NotTo(HaveOccurred())
			})

			It("should load successfully with zero values", func() {
				cfg, err := Parse(configFile)
				Expect(err).NotTo(HaveOccurred())
				Expect(cfg).NotTo(BeNil())
				Expect(cfg.DefaultModel).To(BeEmpty())
			})
		})

	})

	Describe("OpenAI-compatible Endpoints Functions", func() {
		BeforeEach(func() {
			configContent := `
provider_endpoints:
  - name: "endpoint1"
    address: "127.0.0.1"
    port: 8000
    weight: 1
  - name: "endpoint2"
    address: "127.0.0.1"
    port: 8000
    weight: 2
  - name: "endpoint3"
    address: "127.0.0.1"
    port: 8000
    weight: 1

model_config:
  "model-a":
    preferred_endpoints: ["endpoint1", "endpoint3"]
  "model-b":
    preferred_endpoints: ["endpoint2"]
  "model-c":
    # No preferred endpoints configured


default_model: "model-b"
`
			err := os.WriteFile(configFile, []byte(configContent), 0o644)
			Expect(err).NotTo(HaveOccurred())
		})

		Describe("GetEndpointsForModel", func() {
			It("should return preferred endpoints when configured", func() {
				cfg, err := Parse(configFile)
				Expect(err).NotTo(HaveOccurred())

				endpoints := cfg.GetEndpointsForModel("model-a")
				Expect(endpoints).To(HaveLen(2))
				endpointNames := []string{endpoints[0].Name, endpoints[1].Name}
				Expect(endpointNames).To(ContainElements("endpoint1", "endpoint3"))
			})

			It("should return empty slice when no preferred endpoints configured", func() {
				cfg, err := Parse(configFile)
				Expect(err).NotTo(HaveOccurred())

				endpoints := cfg.GetEndpointsForModel("model-c")
				Expect(endpoints).To(BeEmpty())
			})

			It("should return empty slice for non-existent model", func() {
				cfg, err := Parse(configFile)
				Expect(err).NotTo(HaveOccurred())

				endpoints := cfg.GetEndpointsForModel("non-existent-model")
				Expect(endpoints).To(BeEmpty())
			})

			It("should return only preferred endpoints", func() {
				cfg, err := Parse(configFile)
				Expect(err).NotTo(HaveOccurred())

				// model-b has preferred endpoint2
				endpoints := cfg.GetEndpointsForModel("model-b")
				Expect(endpoints).To(HaveLen(1))
				Expect(endpoints[0].Name).To(Equal("endpoint2"))
			})
		})

		Describe("GetEndpointByName", func() {
			It("should return endpoint when it exists", func() {
				cfg, err := Parse(configFile)
				Expect(err).NotTo(HaveOccurred())

				endpoint, found := cfg.GetEndpointByName("endpoint1")
				Expect(found).To(BeTrue())
				Expect(endpoint.Name).To(Equal("endpoint1"))
				Expect(endpoint.Address).To(Equal("127.0.0.1"))
				Expect(endpoint.Port).To(Equal(8000))
			})

			It("should return false when endpoint doesn't exist", func() {
				cfg, err := Parse(configFile)
				Expect(err).NotTo(HaveOccurred())

				endpoint, found := cfg.GetEndpointByName("non-existent")
				Expect(found).To(BeFalse())
				Expect(endpoint).To(BeNil())
			})
		})

		Describe("SelectBestEndpointWithDetailsForModel", func() {
			It("should return address and endpoint name for model with single endpoint", func() {
				cfg, err := Parse(configFile)
				Expect(err).NotTo(HaveOccurred())

				// model-b has a single preferred endpoint: endpoint2
				address, endpointName, found, detailErr := cfg.SelectBestEndpointWithDetailsForModel("model-b")
				Expect(detailErr).NotTo(HaveOccurred())
				Expect(found).To(BeTrue())
				Expect(address).To(Equal("127.0.0.1:8000"))
				Expect(endpointName).To(Equal("endpoint2"))
			})

			It("should return the highest-weight endpoint for model with multiple endpoints", func() {
				cfg, err := Parse(configFile)
				Expect(err).NotTo(HaveOccurred())

				// model-a has endpoint1 (weight 1) and endpoint3 (weight 1)
				// Both have the same weight, so we get one of them
				address, endpointName, found, detailErr := cfg.SelectBestEndpointWithDetailsForModel("model-a")
				Expect(detailErr).NotTo(HaveOccurred())
				Expect(found).To(BeTrue())
				Expect(address).To(Equal("127.0.0.1:8000"))
				Expect(endpointName).To(BeElementOf("endpoint1", "endpoint3"))
			})

			It("should return false for non-existent model", func() {
				cfg, err := Parse(configFile)
				Expect(err).NotTo(HaveOccurred())

				address, endpointName, found, detailErr := cfg.SelectBestEndpointWithDetailsForModel("non-existent-model")
				Expect(detailErr).NotTo(HaveOccurred())
				Expect(found).To(BeFalse())
				Expect(address).To(BeEmpty())
				Expect(endpointName).To(BeEmpty())
			})

			It("should return false for model with no preferred endpoints", func() {
				cfg, err := Parse(configFile)
				Expect(err).NotTo(HaveOccurred())

				// model-c has no preferred endpoints configured
				address, endpointName, found, detailErr := cfg.SelectBestEndpointWithDetailsForModel("model-c")
				Expect(detailErr).NotTo(HaveOccurred())
				Expect(found).To(BeFalse())
				Expect(address).To(BeEmpty())
				Expect(endpointName).To(BeEmpty())
			})

			It("should select the endpoint with the highest weight when weights differ", func() {
				configContent := `
provider_endpoints:
  - name: "ep-low"
    address: "10.0.0.1"
    port: 9000
    weight: 1
  - name: "ep-high"
    address: "10.0.0.2"
    port: 9001
    weight: 10

model_config:
  "weighted-model":
    preferred_endpoints: ["ep-low", "ep-high"]


default_model: "weighted-model"
`
				err := os.WriteFile(configFile, []byte(configContent), 0o644)
				Expect(err).NotTo(HaveOccurred())

				cfg, err := Parse(configFile)
				Expect(err).NotTo(HaveOccurred())

				address, endpointName, found, detailErr := cfg.SelectBestEndpointWithDetailsForModel("weighted-model")
				Expect(detailErr).NotTo(HaveOccurred())
				Expect(found).To(BeTrue())
				Expect(address).To(Equal("10.0.0.2:9001"))
				Expect(endpointName).To(Equal("ep-high"))
			})
		})

		Describe("ResolveExternalModelID", func() {
			It("should resolve external model ID for openai_compatible endpoint type", func() {
				configContent := `
provider_endpoints:
  - name: "openai_compatible-ep"
    address: "127.0.0.1"
    port: 8000
    type: "openai_compatible"

model_config:
  "my-alias":
    preferred_endpoints: ["openai_compatible-ep"]
    external_model_ids:
      openai_compatible: "Qwen/Qwen2.5-14B-Instruct"


default_model: "my-alias"
`
				err := os.WriteFile(configFile, []byte(configContent), 0o644)
				Expect(err).NotTo(HaveOccurred())

				cfg, err := Parse(configFile)
				Expect(err).NotTo(HaveOccurred())

				resolved := cfg.ResolveExternalModelID("my-alias", "openai_compatible-ep")
				Expect(resolved).To(Equal("Qwen/Qwen2.5-14B-Instruct"))
			})

			It("should default to openai_compatible type when endpoint has no type set", func() {
				configContent := `
provider_endpoints:
  - name: "no-type-ep"
    address: "127.0.0.1"
    port: 8000

model_config:
  "my-alias":
    preferred_endpoints: ["no-type-ep"]
    external_model_ids:
      openai_compatible: "Qwen/Qwen2.5-14B-Instruct"


default_model: "my-alias"
`
				err := os.WriteFile(configFile, []byte(configContent), 0o644)
				Expect(err).NotTo(HaveOccurred())

				cfg, err := Parse(configFile)
				Expect(err).NotTo(HaveOccurred())

				// Endpoint has no type, so defaults to "openai_compatible"
				resolved := cfg.ResolveExternalModelID("my-alias", "no-type-ep")
				Expect(resolved).To(Equal("Qwen/Qwen2.5-14B-Instruct"))
			})

			It("should default to openai_compatible type when endpoint name does not exist", func() {
				configContent := `
provider_endpoints:
  - name: "real-ep"
    address: "127.0.0.1"
    port: 8000

model_config:
  "my-alias":
    preferred_endpoints: ["real-ep"]
    external_model_ids:
      openai_compatible: "Qwen/Qwen2.5-14B-Instruct"


default_model: "my-alias"
`
				err := os.WriteFile(configFile, []byte(configContent), 0o644)
				Expect(err).NotTo(HaveOccurred())

				cfg, err := Parse(configFile)
				Expect(err).NotTo(HaveOccurred())

				// Non-existent endpoint name falls back to "openai_compatible" type
				resolved := cfg.ResolveExternalModelID("my-alias", "non-existent-ep")
				Expect(resolved).To(Equal("Qwen/Qwen2.5-14B-Instruct"))
			})

			It("should resolve correct type for ollama endpoint", func() {
				configContent := `
provider_endpoints:
  - name: "ollama-ep"
    address: "127.0.0.1"
    port: 11434
    type: "ollama"

model_config:
  "my-alias":
    preferred_endpoints: ["ollama-ep"]
    external_model_ids:
      openai_compatible: "Qwen/Qwen2.5-14B-Instruct"
      ollama: "qwen2.5:14b"


default_model: "my-alias"
`
				err := os.WriteFile(configFile, []byte(configContent), 0o644)
				Expect(err).NotTo(HaveOccurred())

				cfg, err := Parse(configFile)
				Expect(err).NotTo(HaveOccurred())

				resolved := cfg.ResolveExternalModelID("my-alias", "ollama-ep")
				Expect(resolved).To(Equal("qwen2.5:14b"))
			})

			It("should return original model name when no external_model_ids configured", func() {
				cfg, err := Parse(configFile)
				Expect(err).NotTo(HaveOccurred())

				// Using the base fixture which has no external_model_ids
				resolved := cfg.ResolveExternalModelID("model-a", "endpoint1")
				Expect(resolved).To(Equal("model-a"))
			})

			It("should return original model name for non-existent model", func() {
				cfg, err := Parse(configFile)
				Expect(err).NotTo(HaveOccurred())

				resolved := cfg.ResolveExternalModelID("non-existent-model", "endpoint1")
				Expect(resolved).To(Equal("non-existent-model"))
			})

			It("should return original model name when endpoint type has no mapping", func() {
				configContent := `
provider_endpoints:
  - name: "custom-ep"
    address: "127.0.0.1"
    port: 8000
    type: "openrouter"

model_config:
  "my-alias":
    preferred_endpoints: ["custom-ep"]
    external_model_ids:
      openai_compatible: "Qwen/Qwen2.5-14B-Instruct"


default_model: "my-alias"
`
				err := os.WriteFile(configFile, []byte(configContent), 0o644)
				Expect(err).NotTo(HaveOccurred())

				cfg, err := Parse(configFile)
				Expect(err).NotTo(HaveOccurred())

				// Endpoint type is "openrouter" but external_model_ids only has "openai_compatible"
				resolved := cfg.ResolveExternalModelID("my-alias", "custom-ep")
				Expect(resolved).To(Equal("my-alias"))
			})

			It("should return original model name when config is nil", func() {
				var nilCfg *RouterConfig
				resolved := nilCfg.ResolveExternalModelID("some-model", "some-endpoint")
				Expect(resolved).To(Equal("some-model"))
			})

			It("should return original model name when external_model_ids map is empty", func() {
				configContent := `
provider_endpoints:
  - name: "ep1"
    address: "127.0.0.1"
    port: 8000

model_config:
  "my-alias":
    preferred_endpoints: ["ep1"]
    external_model_ids: {}


default_model: "my-alias"
`
				err := os.WriteFile(configFile, []byte(configContent), 0o644)
				Expect(err).NotTo(HaveOccurred())

				cfg, err := Parse(configFile)
				Expect(err).NotTo(HaveOccurred())

				resolved := cfg.ResolveExternalModelID("my-alias", "ep1")
				Expect(resolved).To(Equal("my-alias"))
			})

			It("translates the retired Regolo glm5.2-beta upstream ID", func() {
				cfg := &RouterConfig{BackendModels: BackendModels{
					ModelConfig: map[string]ModelParams{
						"glm5.2-beta": {PreferredEndpoints: []string{"regolo"}},
					},
					ProviderProfiles: map[string]ProviderProfile{
						"regolo": {Type: "openai_compatible", BaseURL: "https://api.regolo.ai/v1"},
					},
					ProviderEndpoints: []ProviderEndpoint{{Name: "regolo", ProviderProfileName: "regolo"}},
				}}
				Expect(cfg.ResolveExternalModelID("glm5.2-beta", "regolo")).To(Equal("glm5.2"))
			})
		})

		Describe("OpenAI-compatible Endpoint Address Validation", func() {
			Context("with valid IP addresses", func() {
				It("should accept IPv4 addresses", func() {
					configContent := `
provider_endpoints:
  - name: "endpoint1"
    address: "127.0.0.1"
    port: 8000
    weight: 1

model_config:
  "test-model":
    preferred_endpoints: ["endpoint1"]


default_model: "test-model"
`
					err := os.WriteFile(configFile, []byte(configContent), 0o644)
					Expect(err).NotTo(HaveOccurred())

					cfg, err := Parse(configFile)
					Expect(err).NotTo(HaveOccurred())
					Expect(cfg.ProviderEndpoints[0].Address).To(Equal("127.0.0.1"))
				})

				It("should accept IPv6 addresses", func() {
					configContent := `
provider_endpoints:
  - name: "endpoint1"
    address: "::1"
    port: 8000
    weight: 1

model_config:
  "test-model":
    preferred_endpoints: ["endpoint1"]


default_model: "test-model"
`
					err := os.WriteFile(configFile, []byte(configContent), 0o644)
					Expect(err).NotTo(HaveOccurred())

					cfg, err := Parse(configFile)
					Expect(err).NotTo(HaveOccurred())
					Expect(cfg.ProviderEndpoints[0].Address).To(Equal("::1"))
				})

				It("should accept domain names", func() {
					configContent := `
provider_endpoints:
  - name: "endpoint1"
    address: "example.com"
    port: 8000
    weight: 1

model_config:
  "test-model":
    preferred_endpoints: ["endpoint1"]


default_model: "test-model"
`
					err := os.WriteFile(configFile, []byte(configContent), 0o644)
					Expect(err).NotTo(HaveOccurred())

					cfg, err := Parse(configFile)
					Expect(err).NotTo(HaveOccurred())
					Expect(cfg.ProviderEndpoints[0].Address).To(Equal("example.com"))
				})
			})
		})
	})

	Describe("Provider Profiles", func() {
		Context("YAML parsing", func() {
			It("should parse provider_profiles and endpoint references", func() {
				yamlData := `
provider_profiles:
  openai-prod:
    type: "openai"
    base_url: "https://api.openai.com/v1"
  azure-east:
    type: "azure-openai"
    base_url: "https://myresource.openai.azure.com/openai/deployments/gpt-4o"
    api_version: "2024-10-21"
  anthropic-prod:
    type: "anthropic"
    base_url: "https://api.anthropic.com"
    extra_headers:
      anthropic-version: "2023-06-01"
  bedrock-west:
    type: "bedrock"
    base_url: "https://bedrock-mantle.us-west-2.api.aws/v1"
provider_endpoints:
  - name: "openai"
    provider_profile: "openai-prod"
  - name: "azure"
    provider_profile: "azure-east"
  - name: "local-openai_compatible"
    address: "127.0.0.1"
    port: 8000
model_config:
  "gpt-4o":
    preferred_endpoints: ["openai", "azure"]
  "Qwen/Qwen2.5-14B":
    preferred_endpoints: ["local-openai_compatible"]
`
				var cfg RouterConfig
				err := yaml.Unmarshal([]byte(yamlData), &cfg)
				Expect(err).NotTo(HaveOccurred())

				// provider_profiles parsed
				Expect(cfg.ProviderProfiles).To(HaveLen(4))
				Expect(cfg.ProviderProfiles["openai-prod"].Type).To(Equal("openai"))
				Expect(cfg.ProviderProfiles["azure-east"].APIVersion).To(Equal("2024-10-21"))
				Expect(cfg.ProviderProfiles["anthropic-prod"].ExtraHeaders).To(HaveKeyWithValue("anthropic-version", "2023-06-01"))

				// endpoint references
				Expect(cfg.ProviderEndpoints).To(HaveLen(3))
				Expect(cfg.ProviderEndpoints[0].ProviderProfileName).To(Equal("openai-prod"))
				Expect(cfg.ProviderEndpoints[2].ProviderProfileName).To(BeEmpty())
			})
		})

		Context("ResolveAddress", func() {
			It("should extract host:port from base_url", func() {
				profiles := map[string]ProviderProfile{
					"openai-prod": {Type: "openai", BaseURL: "https://api.openai.com/v1"},
					"azure-east":  {Type: "azure-openai", BaseURL: "https://myresource.openai.azure.com/openai/deployments/gpt-4o"},
				}

				ep := ProviderEndpoint{Name: "openai", ProviderProfileName: "openai-prod"}
				addr, err := ep.ResolveAddress(profiles)
				Expect(err).NotTo(HaveOccurred())
				Expect(addr).To(Equal("api.openai.com:443"))

				ep2 := ProviderEndpoint{Name: "azure", ProviderProfileName: "azure-east"}
				addr2, err2 := ep2.ResolveAddress(profiles)
				Expect(err2).NotTo(HaveOccurred())
				Expect(addr2).To(Equal("myresource.openai.azure.com:443"))
			})

			It("should use address:port for legacy endpoints (no provider_profile)", func() {
				ep := ProviderEndpoint{Name: "local", Address: "127.0.0.1", Port: 8000}
				addr, err := ep.ResolveAddress(nil)
				Expect(err).NotTo(HaveOccurred())
				Expect(addr).To(Equal("127.0.0.1:8000"))
			})

			It("should error when profile is set but has no base_url", func() {
				profiles := map[string]ProviderProfile{
					"minimal": {Type: "openai"},
				}
				ep := ProviderEndpoint{Name: "ep1", Address: "10.0.0.1", Port: 9000, ProviderProfileName: "minimal"}
				_, err := ep.ResolveAddress(profiles)
				Expect(err).To(HaveOccurred())
				Expect(err.Error()).To(ContainSubstring("no base_url"))
			})

			It("should error when profile is set but does not exist", func() {
				profiles := map[string]ProviderProfile{}
				ep := ProviderEndpoint{Name: "ep1", ProviderProfileName: "missing"}
				_, err := ep.ResolveAddress(profiles)
				Expect(err).To(HaveOccurred())
				Expect(err.Error()).To(ContainSubstring("does not exist"))
			})

			It("should error when profile is set but profiles map is nil", func() {
				ep := ProviderEndpoint{Name: "ep1", ProviderProfileName: "some-profile"}
				_, err := ep.ResolveAddress(nil)
				Expect(err).To(HaveOccurred())
				Expect(err.Error()).To(ContainSubstring("no provider_profiles map"))
			})

			It("should handle explicit port in base_url", func() {
				profiles := map[string]ProviderProfile{
					"custom": {Type: "openai", BaseURL: "http://localhost:8080/v1"},
				}
				ep := ProviderEndpoint{Name: "ep1", ProviderProfileName: "custom"}
				addr, err := ep.ResolveAddress(profiles)
				Expect(err).NotTo(HaveOccurred())
				Expect(addr).To(Equal("localhost:8080"))
			})

			It("should error on unsupported URL scheme", func() {
				profiles := map[string]ProviderProfile{
					"ftp": {Type: "openai", BaseURL: "ftp://files.example.com/v1"},
				}
				ep := ProviderEndpoint{Name: "ep1", ProviderProfileName: "ftp"}
				_, err := ep.ResolveAddress(profiles)
				Expect(err).To(HaveOccurred())
				Expect(err.Error()).To(ContainSubstring("unsupported scheme"))
			})
		})

		Context("ResolveAuthHeader", func() {
			It("should return type-specific defaults", func() {
				h, p, err := (&ProviderProfile{Type: "openai"}).ResolveAuthHeader()
				Expect(err).NotTo(HaveOccurred())
				Expect(h).To(Equal("Authorization"))
				Expect(p).To(Equal("Bearer"))

				h, p, err = (&ProviderProfile{Type: "anthropic"}).ResolveAuthHeader()
				Expect(err).NotTo(HaveOccurred())
				Expect(h).To(Equal("x-api-key"))
				Expect(p).To(BeEmpty())

				h, p, err = (&ProviderProfile{Type: "azure-openai"}).ResolveAuthHeader()
				Expect(err).NotTo(HaveOccurred())
				Expect(h).To(Equal("api-key"))
				Expect(p).To(BeEmpty())

				h, p, err = (&ProviderProfile{Type: "bedrock"}).ResolveAuthHeader()
				Expect(err).NotTo(HaveOccurred())
				Expect(h).To(Equal("Authorization"))
				Expect(p).To(Equal("Bearer"))
			})

			It("should allow explicit overrides", func() {
				profile := &ProviderProfile{
					Type:       "openai",
					AuthHeader: "X-Custom-Auth",
					AuthPrefix: "Token",
				}
				h, p, err := profile.ResolveAuthHeader()
				Expect(err).NotTo(HaveOccurred())
				Expect(h).To(Equal("X-Custom-Auth"))
				Expect(p).To(Equal("Token"))
			})

			It("should error on unknown type", func() {
				_, _, err := (&ProviderProfile{Type: "bogus"}).ResolveAuthHeader()
				Expect(err).To(HaveOccurred())
				Expect(err.Error()).To(ContainSubstring("unknown provider type"))
			})
		})

		Context("ResolveChatPath", func() {
			It("should return type-specific default paths", func() {
				path, err := (&ProviderProfile{Type: "openai", BaseURL: "https://api.openai.com/v1"}).ResolveChatPath()
				Expect(err).NotTo(HaveOccurred())
				Expect(path).To(Equal("/v1/chat/completions"))

				path, err = (&ProviderProfile{Type: "anthropic", BaseURL: "https://api.anthropic.com"}).ResolveChatPath()
				Expect(err).NotTo(HaveOccurred())
				Expect(path).To(Equal("/v1/messages"))
			})

			It("should append api-version for azure-openai", func() {
				profile := &ProviderProfile{
					Type:       "azure-openai",
					BaseURL:    "https://myresource.openai.azure.com/openai/deployments/gpt-4o",
					APIVersion: "2024-10-21",
				}
				path, err := profile.ResolveChatPath()
				Expect(err).NotTo(HaveOccurred())
				Expect(path).To(Equal("/openai/deployments/gpt-4o/chat/completions?api-version=2024-10-21"))
			})

			It("should error for unrecognised type", func() {
				_, err := (&ProviderProfile{Type: "unknown-provider"}).ResolveChatPath()
				Expect(err).To(HaveOccurred())
				Expect(err.Error()).To(ContainSubstring("unknown provider type"))
			})

			It("should use explicit ChatPath override", func() {
				profile := &ProviderProfile{Type: "openai", ChatPath: "/custom/path"}
				path, err := profile.ResolveChatPath()
				Expect(err).NotTo(HaveOccurred())
				Expect(path).To(Equal("/custom/path"))
			})

			It("should error for nil profile", func() {
				var nilProfile *ProviderProfile
				_, err := nilProfile.ResolveChatPath()
				Expect(err).To(HaveOccurred())
				Expect(err.Error()).To(ContainSubstring("nil"))
			})
		})

		Context("ExtraHeaders", func() {
			It("should pass through explicit extra_headers only", func() {
				profile := &ProviderProfile{
					Type:         "anthropic",
					ExtraHeaders: map[string]string{"anthropic-version": "2023-06-01", "custom": "value"},
				}
				Expect(profile.ExtraHeaders).To(HaveKeyWithValue("anthropic-version", "2023-06-01"))
				Expect(profile.ExtraHeaders).To(HaveKeyWithValue("custom", "value"))
			})

			It("should be nil when not configured", func() {
				profile := &ProviderProfile{Type: "openai"}
				Expect(profile.ExtraHeaders).To(BeNil())
			})
		})

		Context("GetProviderProfileForEndpoint", func() {
			It("should resolve endpoint to profile", func() {
				cfg := &RouterConfig{
					BackendModels: BackendModels{
						ProviderEndpoints: []ProviderEndpoint{
							{Name: "openai", ProviderProfileName: "openai-prod"},
							{Name: "local", Address: "127.0.0.1", Port: 8000},
						},
						ProviderProfiles: map[string]ProviderProfile{
							"openai-prod": {Type: "openai", BaseURL: "https://api.openai.com/v1"},
						},
					},
				}
				profile, err := cfg.GetProviderProfileForEndpoint("openai")
				Expect(err).NotTo(HaveOccurred())
				Expect(profile).NotTo(BeNil())
				Expect(profile.Type).To(Equal("openai"))

				// Endpoint without profile — valid, returns nil profile and no error
				profile, err = cfg.GetProviderProfileForEndpoint("local")
				Expect(err).NotTo(HaveOccurred())
				Expect(profile).To(BeNil())
			})

			It("should error on non-existent endpoint", func() {
				cfg := &RouterConfig{
					BackendModels: BackendModels{
						ProviderEndpoints: []ProviderEndpoint{
							{Name: "local", Address: "127.0.0.1", Port: 8000},
						},
					},
				}
				_, err := cfg.GetProviderProfileForEndpoint("nonexistent")
				Expect(err).To(HaveOccurred())
				Expect(err.Error()).To(ContainSubstring("not found"))
			})

			It("should error on dangling profile reference", func() {
				cfg := &RouterConfig{
					BackendModels: BackendModels{
						ProviderEndpoints: []ProviderEndpoint{
							{Name: "openai", ProviderProfileName: "missing-profile"},
						},
						ProviderProfiles: map[string]ProviderProfile{
							"other-profile": {Type: "openai"},
						},
					},
				}
				_, err := cfg.GetProviderProfileForEndpoint("openai")
				Expect(err).To(HaveOccurred())
				Expect(err.Error()).To(ContainSubstring("does not exist"))
				Expect(err.Error()).To(ContainSubstring("missing-profile"))
			})
		})

		Context("SelectBestEndpointWithDetailsForModel with profiles", func() {
			It("should use base_url for address resolution", func() {
				cfg := &RouterConfig{
					BackendModels: BackendModels{
						ModelConfig: map[string]ModelParams{
							"gpt-4o": {PreferredEndpoints: []string{"openai"}},
						},
						ProviderEndpoints: []ProviderEndpoint{
							{Name: "openai", ProviderProfileName: "openai-prod"},
						},
						ProviderProfiles: map[string]ProviderProfile{
							"openai-prod": {Type: "openai", BaseURL: "https://api.openai.com/v1"},
						},
					},
				}

				addr, name, found, detailErr := cfg.SelectBestEndpointWithDetailsForModel("gpt-4o")
				Expect(detailErr).NotTo(HaveOccurred())
				Expect(found).To(BeTrue())
				Expect(name).To(Equal("openai"))
				Expect(addr).To(Equal("api.openai.com:443"))
			})
		})
	})
})
