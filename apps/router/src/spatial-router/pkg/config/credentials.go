package config

import (
	"context"
	"fmt"
	"net/url"
	"os"
	"regexp"
	"strings"
)

var credentialPlaceholder = regexp.MustCompile(`\$(\{[^}]*\}|[A-Za-z_][A-Za-z0-9_]*)`)

// ValidateCredential rejects empty credentials and unresolved environment references.
// Errors deliberately exclude the credential value.
func ValidateCredential(value string) (string, error) {
	value = strings.TrimSpace(value)
	if value == "" || credentialPlaceholder.MatchString(value) {
		return "", fmt.Errorf("credential is empty or contains an unresolved environment reference")
	}
	return value, nil
}

func expandCredential(value string) (string, error) {
	missing := false
	expanded := os.Expand(value, func(name string) string {
		v, ok := os.LookupEnv(name)
		if !ok || strings.TrimSpace(v) == "" {
			missing = true
		}
		return v
	})
	if missing {
		return "", fmt.Errorf("credential references a missing or empty environment variable")
	}
	return ValidateCredential(expanded)
}

// ResolveCredentialEnv reads a required server credential, including Secret-injected values.
func ResolveCredentialEnv(name string) (string, error) {
	value, ok := os.LookupEnv(name)
	if !ok {
		return "", fmt.Errorf("credential environment variable %q is missing", name)
	}
	key, err := ValidateCredential(value)
	if err != nil {
		return "", fmt.Errorf("credential environment variable %q: %w", name, err)
	}
	return key, nil
}

// IsRegoloEndpoint identifies Regolo hosts without matching unrelated suffixes.
func IsRegoloEndpoint(endpoint string) bool {
	u, err := url.Parse(endpoint)
	if err != nil {
		return false
	}
	host := strings.TrimSuffix(strings.ToLower(u.Hostname()), ".")
	return host == "regolo.ai" || strings.HasSuffix(host, ".regolo.ai")
}

// ResolveModelAccessKey resolves only the model's server-side credential.
func (c *RouterConfig) ResolveModelAccessKey(model string) (string, error) {
	if c == nil {
		return "", nil
	}
	m := c.ModelConfig[model]
	if m.AccessKeyEnv != "" {
		if m.AccessKey != "" {
			return "", fmt.Errorf("model %q specifies both access_key and access_key_env", model)
		}
		return ResolveCredentialEnv(m.AccessKeyEnv)
	}
	if m.AccessKey != "" {
		return expandCredential(m.AccessKey)
	}
	return "", nil
}

// ResolveUpstreamAPIKey uses the request credential for Regolo, never a server key.
// Regolo may also be identified by a provider profile backed by a private gateway.
func (c *RouterConfig) ResolveUpstreamAPIKey(model, clientKey string, regolo bool) (string, error) {
	regolo = regolo || c.ModelUsesRegolo(model)
	if regolo {
		return ValidateCredential(clientKey)
	}
	key, err := c.ResolveModelAccessKey(model)
	if err != nil {
		return "", err
	}
	if c != nil {
		for _, m := range c.SkillRouter.Models {
			if m.Model == model && m.HasExplicitAPIKeySource() {
				return ValidateCredential(m.ResolveAPIKey(""))
			}
		}
	}
	if key != "" {
		return key, nil
	}
	return clientKey, nil
}

// ModelUsesRegolo identifies models associated with Regolo endpoints or profiles.
func (c *RouterConfig) ModelUsesRegolo(model string) bool {
	if c == nil {
		return false
	}
	for _, m := range c.SkillRouter.Models {
		if m.Model == model && IsRegoloEndpoint(m.BaseURL) {
			return true
		}
	}
	for _, endpoint := range c.ModelConfig[model].PreferredEndpoints {
		if endpoint == "regolo" || endpoint == "regoloai" {
			return true
		}
		for _, ep := range c.ProviderEndpoints {
			if ep.Name == endpoint && (ep.ProviderProfileName == "regolo" || ep.ProviderProfileName == "regoloai") {
				return true
			}
		}
		if profile, err := c.GetProviderProfileForEndpoint(endpoint); err == nil && profile != nil && IsRegoloEndpoint(profile.BaseURL) {
			return true
		}
	}
	return false
}

func validateCredentials(cfg *RouterConfig) error {
	for name := range cfg.ModelConfig {
		if cfg.ModelUsesRegolo(name) {
			continue
		}
		if _, err := cfg.ResolveModelAccessKey(name); err != nil {
			return fmt.Errorf("model_config.%s: %w", name, err)
		}
	}
	for _, m := range cfg.SkillRouter.Models {
		if m.HasExplicitAPIKeySource() && !cfg.ModelUsesRegolo(m.Model) && !IsRegoloEndpoint(m.BaseURL) {
			if _, err := ValidateCredential(m.ResolveAPIKey("")); err != nil {
				return fmt.Errorf("skill_router.models.%s: %w", m.Model, err)
			}
		}
	}
	if cfg.ComplexityService != nil && !cfg.ComplexityService.UsesClientKey() {
		if _, err := cfg.ComplexityService.ResolveBearerToken(); err != nil {
			return fmt.Errorf("complexity_service: %w", err)
		}
	}
	m := cfg.SkillRouter.ComplexityModel
	if !m.UseClientKey && !IsRegoloEndpoint(m.BaseURL) && (m.BearerToken != "" || m.BearerTokenFile != "") {
		if _, err := (&ComplexityServiceConfig{BearerToken: m.BearerToken, BearerTokenFile: m.BearerTokenFile}).ResolveBearerToken(); err != nil {
			return fmt.Errorf("skill_router.complexity_model: %w", err)
		}
	}
	return nil
}

// Request credentials are scoped to the context, never stored in shared router state.
type clientAPIKeyContextKey struct{}

// WithClientAPIKey attaches the current user credential to a request context.
func WithClientAPIKey(ctx context.Context, key string) context.Context {
	return context.WithValue(ctx, clientAPIKeyContextKey{}, key)
}

// ClientAPIKey retrieves the credential for this request only.
func ClientAPIKey(ctx context.Context) string {
	key, _ := ctx.Value(clientAPIKeyContextKey{}).(string)
	return key
}

// UsesClientKey reports whether classification uses the current user credential.
func (c *ComplexityServiceConfig) UsesClientKey() bool {
	return c != nil && (c.UseClientKey || IsRegoloEndpoint(c.BaseURL))
}
