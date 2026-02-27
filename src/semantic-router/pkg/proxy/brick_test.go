package proxy

import (
	"encoding/json"
	"testing"
)

func TestExtractHost(t *testing.T) {
	tests := []struct {
		name     string
		input    string
		expected string
	}{
		// Standard cases
		{
			name:     "https with path",
			input:    "https://api.regolo.ai/v1/chat/completions",
			expected: "https://api.regolo.ai:443",
		},
		{
			name:     "https no path",
			input:    "https://api.regolo.ai",
			expected: "https://api.regolo.ai:443",
		},
		{
			name:     "https with explicit port",
			input:    "https://api.regolo.ai:8443/v1",
			expected: "https://api.regolo.ai:8443",
		},
		{
			name:     "http with path",
			input:    "http://localhost:8000/v1/chat/completions",
			expected: "http://localhost:8000",
		},
		{
			name:     "http no port",
			input:    "http://example.com/api",
			expected: "http://example.com:80",
		},

		// IPv6 cases (C1 fix)
		{
			name:     "ipv6 with brackets and port",
			input:    "http://[::1]:8080/v1",
			expected: "http://[::1]:8080",
		},
		{
			name:     "ipv6 with brackets no port",
			input:    "http://[::1]/v1",
			expected: "http://[::1]:80",
		},
		{
			name:     "ipv6 full address with brackets",
			input:    "https://[fe80::1]:443/api",
			expected: "https://[fe80::1]:443",
		},

		// Empty/invalid cases (C2 fix)
		{
			name:     "empty string",
			input:    "",
			expected: "",
		},
		{
			name:     "just a path",
			input:    "/v1/chat/completions",
			expected: "",
		},

		// Trailing slash
		{
			name:     "trailing slash",
			input:    "https://api.regolo.ai/",
			expected: "https://api.regolo.ai:443",
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			result := extractHost(tc.input)
			if result != tc.expected {
				t.Errorf("extractHost(%q) = %q, want %q", tc.input, result, tc.expected)
			}
		})
	}
}

func TestExtractPath(t *testing.T) {
	tests := []struct {
		name     string
		input    string
		expected string
	}{
		{
			name:     "standard URL with path",
			input:    "https://api.regolo.ai/v1/chat/completions",
			expected: "/v1/chat/completions",
		},
		{
			name:     "URL with single path segment",
			input:    "https://api.regolo.ai/v1",
			expected: "/v1",
		},
		{
			name:     "URL with trailing slash",
			input:    "https://api.regolo.ai/v1/",
			expected: "/v1",
		},
		{
			name:     "URL no path",
			input:    "https://api.regolo.ai",
			expected: "",
		},
		{
			name:     "URL root path only",
			input:    "https://api.regolo.ai/",
			expected: "",
		},
		{
			name:     "empty string",
			input:    "",
			expected: "",
		},
		{
			name:     "ipv6 with path",
			input:    "http://[::1]:8080/v1/models",
			expected: "/v1/models",
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			result := extractPath(tc.input)
			if result != tc.expected {
				t.Errorf("extractPath(%q) = %q, want %q", tc.input, result, tc.expected)
			}
		})
	}
}

func TestRewriteModelInBody(t *testing.T) {
	tests := []struct {
		name      string
		body      string
		newModel  string
		wantModel string
	}{
		{
			name:      "simple rewrite",
			body:      `{"model":"brick","messages":[]}`,
			newModel:  "Qwen3-8B",
			wantModel: "Qwen3-8B",
		},
		{
			name:      "rewrite preserves other fields",
			body:      `{"model":"brick","stream":true,"messages":[{"role":"user","content":"hi"}]}`,
			newModel:  "gpt-oss-120b",
			wantModel: "gpt-oss-120b",
		},
		{
			name:      "invalid JSON returns original",
			body:      `not json`,
			newModel:  "test",
			wantModel: "", // won't parse, returns original
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			result := rewriteModelInBody([]byte(tc.body), tc.newModel)
			if tc.wantModel == "" {
				// For invalid JSON, should return original
				if string(result) != tc.body {
					t.Errorf("expected original body returned for invalid JSON")
				}
				return
			}
			// Parse result to check model field
			var parsed map[string]interface{}
			if err := json.Unmarshal(result, &parsed); err != nil {
				t.Fatalf("result is not valid JSON: %v", err)
			}
			if got := parsed["model"]; got != tc.wantModel {
				t.Errorf("model = %q, want %q", got, tc.wantModel)
			}
		})
	}
}

func TestMergeMaps(t *testing.T) {
	tests := []struct {
		name string
		dst  map[string]string
		src  map[string]string
		want map[string]string
	}{
		{
			name: "nil dst",
			dst:  nil,
			src:  map[string]string{"a": "1"},
			want: map[string]string{"a": "1"},
		},
		{
			name: "no overwrite existing",
			dst:  map[string]string{"a": "original"},
			src:  map[string]string{"a": "new", "b": "2"},
			want: map[string]string{"a": "original", "b": "2"},
		},
		{
			name: "nil src",
			dst:  map[string]string{"a": "1"},
			src:  nil,
			want: map[string]string{"a": "1"},
		},
		{
			name: "both nil",
			dst:  nil,
			src:  nil,
			want: map[string]string{},
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			result := mergeMaps(tc.dst, tc.src)
			if len(result) != len(tc.want) {
				t.Fatalf("len(result) = %d, want %d", len(result), len(tc.want))
			}
			for k, v := range tc.want {
				if result[k] != v {
					t.Errorf("result[%q] = %q, want %q", k, result[k], v)
				}
			}
		})
	}
}

func TestGetRegoloProviderInfo(t *testing.T) {
	t.Run("nil config", func(t *testing.T) {
		baseURL, apiKey := getRegoloProviderInfo(nil)
		if baseURL != "https://api.regolo.ai/v1" {
			t.Errorf("baseURL = %q, want default", baseURL)
		}
		if apiKey != "" {
			t.Errorf("apiKey should be empty for nil config without env, got %q", apiKey)
		}
	})
}

// TestExtractHostForwardIntegration verifies that extractHost output
// works correctly with forwardToBackend's scheme detection logic.
func TestExtractHostForwardIntegration(t *testing.T) {
	tests := []struct {
		name       string
		input      string
		wantScheme string // should start with this
	}{
		{
			name:       "https URL keeps https",
			input:      "https://api.regolo.ai/v1",
			wantScheme: "https://",
		},
		{
			name:       "http URL keeps http",
			input:      "http://localhost:8000/v1",
			wantScheme: "http://",
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			host := extractHost(tc.input)
			// forwardToBackend checks: if !strings.HasPrefix(endpoint, "http")
			// Our output must start with "http" to avoid double-prefix
			if len(host) < 4 || host[:4] != "http" {
				t.Errorf("extractHost(%q) = %q, must start with 'http' for forwardToBackend compatibility", tc.input, host)
			}
			if len(host) < len(tc.wantScheme) || host[:len(tc.wantScheme)] != tc.wantScheme {
				t.Errorf("extractHost(%q) = %q, want prefix %q", tc.input, host, tc.wantScheme)
			}
		})
	}
}
