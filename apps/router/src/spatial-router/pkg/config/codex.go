package config

import (
	"errors"
	"fmt"
	"net/url"
	"strings"
)

var ErrCodexUnsupported = errors.New("unsupported Codex operation or protocol")

// CodexRouterConfig is a separate trust boundary from caller-key deployments.
// Activation requires protocol and live tool-cycle verification outside the router.
type CodexRouterConfig struct {
	Enabled        bool   `yaml:"enabled"`
	LocalKeyEnv    string `yaml:"local_key_env"`
	TimeoutSeconds int    `yaml:"timeout_seconds,omitempty"`
}

type CodexDestination struct {
	Model         string
	UpstreamModel string
	Provider      string
	URL           string
	Operation     string
	Protocol      string
	AuthSource    string
	APIKeyEnv     string
	Capabilities  []string
}

// ResolveCodexDestination never guesses a provider or falls back to Regolo.
func (c *RouterConfig) ResolveCodexDestination(model, operation string) (CodexDestination, error) {
	d := CodexDestination{Model: model, UpstreamModel: model, Operation: operation}
	m, ok := c.ModelConfig[model]
	if !ok || len(m.PreferredEndpoints) != 1 {
		return d, fmt.Errorf("model %q must have exactly one authoritative provider endpoint", model)
	}
	p, err := c.GetProviderProfileForEndpoint(m.PreferredEndpoints[0])
	if err != nil || p == nil {
		return d, fmt.Errorf("model %q has no provider profile", model)
	}
	for _, ep := range c.ProviderEndpoints {
		if ep.Name == m.PreferredEndpoints[0] {
			d.Provider = ep.ProviderProfileName
		}
	}
	if m.UpstreamModel != "" {
		d.UpstreamModel = m.UpstreamModel
	}
	d.Protocol, d.AuthSource, d.APIKeyEnv = p.Protocol, p.AuthSource, p.APIKeyEnv
	d.Capabilities = append([]string(nil), p.Capabilities...)
	if m.TransportCapabilities != nil {
		d.Capabilities = append([]string(nil), m.TransportCapabilities...)
	}
	if d.Protocol != "responses" && d.Protocol != "chat_completions" {
		return d, fmt.Errorf("%w: provider %q protocol %q has no verified Responses adapter", ErrCodexUnsupported, d.Provider, d.Protocol)
	}
	suffix := p.ResponsesPath
	if d.Protocol == "chat_completions" {
		suffix = p.ChatPath
		if suffix == "" {
			suffix = "chat/completions"
		}
		if operation != "responses" {
			return d, fmt.Errorf("%w: Chat adapter does not support compaction", ErrCodexUnsupported)
		}
	}
	if suffix == "" {
		suffix = "responses"
	}
	if operation == "compact" {
		suffix = p.CompactPath
		if suffix == "" {
			return d, fmt.Errorf("%w: provider %q does not support compaction", ErrCodexUnsupported, d.Provider)
		}
	}
	if operation != "responses" && operation != "compact" {
		return d, fmt.Errorf("unsupported operation")
	}
	u, err := url.Parse(p.BaseURL)
	if err != nil || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || (u.Scheme != "https" && u.Scheme != "http") {
		return d, fmt.Errorf("provider %q has an invalid base URL", d.Provider)
	}
	if strings.Contains(suffix, ":") || strings.Contains(suffix, "..") || strings.ContainsAny(suffix, "?#") {
		return d, fmt.Errorf("invalid operation path")
	}
	suffix = strings.Trim(suffix, "/")
	base := strings.TrimRight(u.Path, "/")
	if base != "" && strings.HasPrefix("/"+suffix, base+"/") {
		base = "/" + suffix
	} else if !strings.HasSuffix(base, "/"+suffix) {
		base += "/" + suffix
	}
	u.Path = base
	d.URL = u.String()
	switch d.AuthSource {
	case "codex_request":
		// Exact origin and path allowlist: API billing and subscription auth differ.
		if d.Protocol != "responses" || d.Provider != "openai-codex" || u.Scheme != "https" || u.Host != "chatgpt.com" || (u.Path != "/backend-api/codex/responses" && u.Path != "/backend-api/codex/responses/compact") || p.APIKeyEnv != "" {
			return d, fmt.Errorf("Codex request authentication requires the verified Codex upstream")
		}
	case "provider_env":
		if p.APIKeyEnv == "" {
			return d, fmt.Errorf("provider %q requires api_key_env", d.Provider)
		}
	default:
		return d, fmt.Errorf("provider %q requires an explicit auth_source", d.Provider)
	}
	if p.AuthHeader != "" || p.AuthPrefix != "" || len(p.ExtraHeaders) > 0 {
		return d, fmt.Errorf("provider %q custom authentication headers are not supported on the Codex path", d.Provider)
	}
	if m.AccessKey != "" || (m.AccessKeyEnv != "" && m.AccessKeyEnv != p.APIKeyEnv) {
		return d, fmt.Errorf("model %q credentials conflict with its provider profile", model)
	}
	for _, inline := range c.SkillRouter.Models {
		if inline.Model != model {
			continue
		}
		if (inline.BaseURL != "" && strings.TrimRight(inline.BaseURL, "/") != strings.TrimRight(p.BaseURL, "/")) || inline.APIKey != "" || inline.APIKeyFile != "" || (inline.APIKeyEnv != "" && inline.APIKeyEnv != p.APIKeyEnv) {
			return d, fmt.Errorf("model %q inline transport conflicts with its provider profile", model)
		}
	}
	return d, nil
}
