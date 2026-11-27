package config

import (
	"fmt"
	"net/url"
	"strings"
)

// GetModelReasoningFamily returns the reasoning family configuration for a given model name
func (rc *RouterConfig) GetModelReasoningFamily(modelName string) *ReasoningFamilyConfig {
	if rc == nil || rc.ModelConfig == nil || rc.ReasoningFamilies == nil {
		return nil
	}

	// Look up the model in model_config
	modelParams, exists := rc.ModelConfig[modelName]
	if !exists || modelParams.ReasoningFamily == "" {
		return nil
	}

	// Look up the reasoning family configuration
	familyConfig, exists := rc.ReasoningFamilies[modelParams.ReasoningFamily]
	if !exists {
		return nil
	}

	return &familyConfig
}

// GetEndpointsForModel returns all endpoints that can serve the specified model
// Returns endpoints based on the model's preferred_endpoints configuration in model_config
func (c *RouterConfig) GetEndpointsForModel(modelName string) []ProviderEndpoint {
	var endpoints []ProviderEndpoint

	// Check if model has preferred endpoints configured
	if modelConfig, ok := c.ModelConfig[modelName]; ok && len(modelConfig.PreferredEndpoints) > 0 {
		// Return only the preferred endpoints
		for _, endpointName := range modelConfig.PreferredEndpoints {
			if endpoint, found := c.GetEndpointByName(endpointName); found {
				endpoints = append(endpoints, *endpoint)
			}
		}
	}

	return endpoints
}

// GetEndpointByName returns the endpoint with the specified name
func (c *RouterConfig) GetEndpointByName(name string) (*ProviderEndpoint, bool) {
	for _, endpoint := range c.ProviderEndpoints {
		if endpoint.Name == name {
			return &endpoint, true
		}
	}
	return nil, false
}

// ResolveExternalModelID resolves the external model ID for a given model name and endpoint.
// When a model alias (e.g., "qwen14b-rack1") is configured with external_model_ids,
// this returns the real model name that the backend expects (e.g., "Qwen/Qwen2.5-14B-Instruct").
// The endpoint type (e.g., "openai_compatible", "ollama") is looked up from the selected endpoint.
// Returns the original modelName if no mapping is found.
func (c *RouterConfig) ResolveExternalModelID(modelName string, endpointName string) string {
	if c == nil || c.ModelConfig == nil {
		return modelName
	}

	modelConfig, ok := c.ModelConfig[modelName]
	if !ok {
		return modelName
	}

	// Get the endpoint type from the endpoint name
	endpointType := ""
	if endpoint, found := c.GetEndpointByName(endpointName); found && endpoint.Type != "" {
		endpointType = endpoint.Type
	} else {
		endpointType = "openai_compatible"
	}

	// Look up the external model ID for this endpoint type
	if len(modelConfig.ExternalModelIDs) > 0 {
		if externalID, ok := modelConfig.ExternalModelIDs[endpointType]; ok && externalID != "" {
			return externalID
		}
	}

	// Regolo retired the public glm5.2-beta identifier in favour of glm5.2.
	// Keep profiles created while the beta identifier was advertised working:
	// their internal routing/economics identity remains stable, while only the
	// upstream request is translated. Restrict this compatibility shim to the
	// Regolo endpoint so a user-defined model with the same local name is not
	// rewritten at another provider.
	if modelName == "glm5.2-beta" {
		if profile, err := c.GetProviderProfileForEndpoint(endpointName); err == nil && profile != nil &&
			strings.Contains(strings.ToLower(profile.BaseURL), "api.regolo.ai") {
			return "glm5.2"
		}
	}

	return modelName
}

// SelectBestEndpointWithDetailsForModel selects the best endpoint for a model and returns
// both the address:port and the endpoint name (needed for external_model_ids resolution).
// Returns (address, endpointName, found).
func (c *RouterConfig) SelectBestEndpointWithDetailsForModel(modelName string) (string, string, bool, error) {
	endpoints := c.GetEndpointsForModel(modelName)
	if len(endpoints) == 0 {
		return "", "", false, nil
	}

	bestEndpoint := endpoints[0]
	for _, endpoint := range endpoints[1:] {
		if endpoint.Weight > bestEndpoint.Weight {
			bestEndpoint = endpoint
		}
	}

	addr, err := bestEndpoint.ResolveAddress(c.ProviderProfiles)
	if err != nil {
		return "", "", false, fmt.Errorf("endpoint %q for model %q: %w", bestEndpoint.Name, modelName, err)
	}
	return addr, bestEndpoint.Name, true, nil
}

type providerTypeInfo struct {
	AuthHeader string // HTTP header name for the API key
	AuthPrefix string // value prefix ("Bearer", "" etc.)
	ChatPath   string // path suffix appended after base_url path
}

var providerTypeRegistry = map[string]providerTypeInfo{
	"openai_compatible": {AuthHeader: "Authorization", AuthPrefix: "Bearer", ChatPath: "/chat/completions"},
	"openai":            {AuthHeader: "Authorization", AuthPrefix: "Bearer", ChatPath: "/chat/completions"},
	"anthropic":         {AuthHeader: "x-api-key", AuthPrefix: "", ChatPath: "/v1/messages"},
	"azure-openai":      {AuthHeader: "api-key", AuthPrefix: "", ChatPath: "/chat/completions"},
	"bedrock":           {AuthHeader: "Authorization", AuthPrefix: "Bearer", ChatPath: "/chat/completions"},
	"gemini":            {AuthHeader: "Authorization", AuthPrefix: "Bearer", ChatPath: "/chat/completions"},
	"vertex-ai":         {AuthHeader: "Authorization", AuthPrefix: "Bearer", ChatPath: "/chat/completions"},
}

// GetProviderProfileForEndpoint resolves the ProviderProfile for a named endpoint.
//
// Returns (nil, nil) when the endpoint exists but has no provider_profile set
// (legacy address:port endpoint — this is not an error).
//
// Returns a non-nil error when:
//   - endpointName does not match any ProviderEndpoint
//   - the endpoint references a provider_profile name that does not exist in the map
func (c *RouterConfig) GetProviderProfileForEndpoint(endpointName string) (*ProviderProfile, error) {
	if endpointName == "" {
		return nil, nil // no endpoint selected (e.g., model has no preferred_endpoints)
	}
	ep, found := c.GetEndpointByName(endpointName)
	if !found {
		return nil, fmt.Errorf("endpoint %q not found in provider_endpoints", endpointName)
	}
	if ep.ProviderProfileName == "" {
		return nil, nil // legacy endpoint, no profile — not an error
	}
	if c.ProviderProfiles == nil {
		return nil, fmt.Errorf("endpoint %q references provider_profile %q but no provider_profiles map is defined",
			endpointName, ep.ProviderProfileName)
	}
	profile, ok := c.ProviderProfiles[ep.ProviderProfileName]
	if !ok {
		return nil, fmt.Errorf("endpoint %q references provider_profile %q which does not exist in provider_profiles (have: %v)",
			endpointName, ep.ProviderProfileName, mapKeys(c.ProviderProfiles))
	}
	return &profile, nil
}

// mapKeys returns the keys of a map for diagnostic messages.
func mapKeys(m map[string]ProviderProfile) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	return keys
}

// ResolveAddress returns the host:port string for this endpoint.
//
// Two distinct modes — no silent fallback between them:
//   - provider_profile set → host:port is extracted from the profile's base_url.
//     Returns error if profile is missing, has no base_url, or base_url is unparsable.
//   - provider_profile NOT set → uses address:port fields directly.
func (ep *ProviderEndpoint) ResolveAddress(profiles map[string]ProviderProfile) (string, error) {
	if ep.ProviderProfileName == "" {
		// Legacy endpoint: address:port is the intended mode.
		return fmt.Sprintf("%s:%d", ep.Address, ep.Port), nil
	}

	// Profile-based endpoint: MUST resolve from base_url.
	if profiles == nil {
		return "", fmt.Errorf("endpoint %q has provider_profile %q but no provider_profiles map is defined",
			ep.Name, ep.ProviderProfileName)
	}
	profile, ok := profiles[ep.ProviderProfileName]
	if !ok {
		return "", fmt.Errorf("endpoint %q references provider_profile %q which does not exist",
			ep.Name, ep.ProviderProfileName)
	}
	if profile.BaseURL == "" {
		return "", fmt.Errorf("endpoint %q: provider_profile %q has no base_url",
			ep.Name, ep.ProviderProfileName)
	}

	u, err := url.Parse(profile.BaseURL)
	if err != nil {
		return "", fmt.Errorf("endpoint %q: cannot parse base_url %q: %w",
			ep.Name, profile.BaseURL, err)
	}
	if u.Host == "" {
		return "", fmt.Errorf("endpoint %q: base_url %q has no host",
			ep.Name, profile.BaseURL)
	}

	host := u.Host
	if !strings.Contains(host, ":") {
		switch u.Scheme {
		case "https":
			host += ":443"
		case "http":
			host += ":80"
		default:
			return "", fmt.Errorf("endpoint %q: base_url %q has unsupported scheme %q (expected http or https)",
				ep.Name, profile.BaseURL, u.Scheme)
		}
	}
	return host, nil
}

// ResolveAuthHeader returns the (headerName, prefix) for the upstream auth header.
// Explicit AuthHeader/AuthPrefix fields override the type defaults.
// Returns error if the profile's type is not recognised.
func (p *ProviderProfile) ResolveAuthHeader() (string, string, error) {
	info, ok := providerTypeRegistry[p.Type]
	if !ok {
		return "", "", fmt.Errorf("unknown provider type %q — cannot determine auth header", p.Type)
	}
	headerName := info.AuthHeader
	prefix := info.AuthPrefix
	if p.AuthHeader != "" {
		headerName = p.AuthHeader
	}
	if p.AuthPrefix != "" {
		prefix = p.AuthPrefix
	}
	return headerName, prefix, nil
}

// ResolveChatPath returns the HTTP path for upstream requests.
//
// Resolution order (no silent fallback):
//  1. Explicit ChatPath field on the profile (used as-is, plus ?api-version for azure-openai).
//  2. base_url path + type-default suffix from providerTypeRegistry.
//  3. Type-default suffix alone if base_url has no path component.
//
// Returns error if the type is not recognised or base_url is unparsable.
func (p *ProviderProfile) ResolveChatPath() (string, error) {
	if p == nil {
		return "", fmt.Errorf("provider profile is nil")
	}

	info, ok := providerTypeRegistry[p.Type]
	if !ok {
		return "", fmt.Errorf("unknown provider type %q — cannot determine chat path", p.Type)
	}

	// Explicit override
	if p.ChatPath != "" {
		path := p.ChatPath
		if p.Type == "azure-openai" && p.APIVersion != "" {
			path += "?api-version=" + p.APIVersion
		}
		return path, nil
	}

	suffix := info.ChatPath
	if p.Type == "azure-openai" && p.APIVersion != "" {
		suffix += "?api-version=" + p.APIVersion
	}

	// Prepend base_url path component if present
	if p.BaseURL != "" {
		u, err := url.Parse(p.BaseURL)
		if err != nil {
			return "", fmt.Errorf("cannot parse base_url %q: %w", p.BaseURL, err)
		}
		if u.Path != "" && u.Path != "/" {
			return strings.TrimRight(u.Path, "/") + suffix, nil
		}
	}

	return suffix, nil
}

// GetAllowedThinkingModes returns the configured effort allowlist, or nil when unrestricted.
func (c *RouterConfig) GetAllowedThinkingModes(modelName string) []string {
	if c == nil || c.ModelConfig == nil {
		return nil
	}
	params, ok := c.ModelConfig[modelName]
	if !ok || len(params.AllowedThinkingModes) == 0 {
		return nil
	}
	return params.AllowedThinkingModes
}
