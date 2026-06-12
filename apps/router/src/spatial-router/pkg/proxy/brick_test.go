package proxy

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"github.com/regolo-ai/brick-SR1/apps/router/src/spatial-router/pkg/config"
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

func TestFindSkillRouterModel(t *testing.T) {
	cfg := &config.RouterConfig{
		SkillRouter: config.SkillRouterConfig{
			Models: []config.SkillRouterModelConfig{
				{Model: "openai/gpt-4o-mini", BaseURL: "https://openrouter.ai/api/v1"},
				{Model: "anthropic/claude", BaseURL: "https://openrouter.ai/api/v1"},
			},
		},
	}
	if got := findSkillRouterModel(cfg, "openai/gpt-4o-mini"); got == nil || got.BaseURL == "" {
		t.Fatalf("expected match with BaseURL, got %+v", got)
	}
	if got := findSkillRouterModel(cfg, "missing/model"); got != nil {
		t.Fatalf("expected nil for missing model, got %+v", got)
	}
	if got := findSkillRouterModel(nil, "openai/gpt-4o-mini"); got != nil {
		t.Fatalf("expected nil for nil config, got %+v", got)
	}
}

func TestMergeCustomParamsIntoBody(t *testing.T) {
	tests := []struct {
		name   string
		body   string
		params map[string]interface{}
		want   map[string]interface{}
	}{
		{
			name:   "nil params returns body unchanged",
			body:   `{"model":"x","messages":[]}`,
			params: nil,
			want:   map[string]interface{}{"model": "x", "messages": []interface{}{}},
		},
		{
			name:   "adds new keys",
			body:   `{"model":"x"}`,
			params: map[string]interface{}{"temperature": 0.7, "max_tokens": 4096},
			want:   map[string]interface{}{"model": "x", "temperature": 0.7, "max_tokens": float64(4096)},
		},
		{
			name:   "does NOT overwrite existing keys (client wins)",
			body:   `{"model":"x","temperature":0.2}`,
			params: map[string]interface{}{"temperature": 0.9, "top_p": 0.95},
			want:   map[string]interface{}{"model": "x", "temperature": 0.2, "top_p": 0.95},
		},
		{
			name:   "invalid JSON returns body unchanged",
			body:   `not-json{`,
			params: map[string]interface{}{"temperature": 0.7},
			want:   nil, // sentinel: just compare bytes
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			out := mergeCustomParamsIntoBody([]byte(tc.body), tc.params)
			if tc.want == nil {
				if string(out) != tc.body {
					t.Fatalf("expected body unchanged, got %s", string(out))
				}
				return
			}
			var got map[string]interface{}
			if err := json.Unmarshal(out, &got); err != nil {
				t.Fatalf("unmarshal merged body: %v", err)
			}
			for k, v := range tc.want {
				if gotV, ok := got[k]; !ok {
					t.Errorf("missing key %q", k)
				} else if !equalJSON(gotV, v) {
					t.Errorf("key %q: got %v, want %v", k, gotV, v)
				}
			}
		})
	}
}

func equalJSON(a, b interface{}) bool {
	ab, _ := json.Marshal(a)
	bb, _ := json.Marshal(b)
	return string(ab) == string(bb)
}

func TestBuildForwardResultForModel_PerModelEndpoint(t *testing.T) {
	cfg := &config.RouterConfig{
		SkillRouter: config.SkillRouterConfig{
			Models: []config.SkillRouterModelConfig{
				{
					Model:     "openai/gpt-4o-mini",
					BaseURL:   "https://openrouter.ai/api/v1",
					APIKeyEnv: "TEST_OPENROUTER_KEY",
					CustomParams: map[string]interface{}{
						"top_p": 0.95,
					},
				},
			},
		},
	}
	os.Setenv("TEST_OPENROUTER_KEY", "sk-or-v1-resolved")
	defer os.Unsetenv("TEST_OPENROUTER_KEY")

	srv := &Server{cfg: cfg}
	body := []byte(`{"model":"openai/gpt-4o-mini","messages":[]}`)
	result := srv.buildForwardResultForModel(body, cfg, "openai/gpt-4o-mini", false, "client-key-fallback")

	if result.ForwardEndpoint != "https://openrouter.ai:443" {
		t.Errorf("ForwardEndpoint = %q, want openrouter host", result.ForwardEndpoint)
	}
	if result.ForwardPath != "/api/v1/chat/completions" {
		t.Errorf("ForwardPath = %q, want /api/v1/chat/completions", result.ForwardPath)
	}
	if result.ForwardHeaders["Authorization"] != "Bearer sk-or-v1-resolved" {
		t.Errorf("Authorization = %q, want resolved from env", result.ForwardHeaders["Authorization"])
	}
	var got map[string]interface{}
	if err := json.Unmarshal(result.ForwardBody, &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if got["top_p"] != 0.95 {
		t.Errorf("top_p not merged: %v", got["top_p"])
	}
}

func TestBuildForwardResultForModel_FallbackLegacy(t *testing.T) {
	// Model has no BaseURL → fallback to regolo legacy.
	cfg := &config.RouterConfig{
		SkillRouter: config.SkillRouterConfig{
			Models: []config.SkillRouterModelConfig{
				{Model: "qwen3.5-122b"}, // no BaseURL
			},
		},
	}
	srv := &Server{cfg: cfg}
	body := []byte(`{"model":"qwen3.5-122b"}`)
	result := srv.buildForwardResultForModel(body, cfg, "qwen3.5-122b", false, "client-key")
	if result.ForwardEndpoint != "https://api.regolo.ai:443" {
		t.Errorf("expected regolo fallback, got %q", result.ForwardEndpoint)
	}
	if result.ForwardHeaders["Authorization"] != "Bearer client-key" {
		t.Errorf("expected client key in fallback, got %q", result.ForwardHeaders["Authorization"])
	}
}

func TestBuildForwardResultForModel_UnknownModelFallsBack(t *testing.T) {
	cfg := &config.RouterConfig{
		SkillRouter: config.SkillRouterConfig{
			Models: []config.SkillRouterModelConfig{
				{Model: "known", BaseURL: "https://example.com/v1"},
			},
		},
	}
	srv := &Server{cfg: cfg}
	body := []byte(`{"model":"unknown"}`)
	result := srv.buildForwardResultForModel(body, cfg, "unknown", false, "client-key")
	if result.ForwardEndpoint != "https://api.regolo.ai:443" {
		t.Errorf("expected regolo fallback for unknown model, got %q", result.ForwardEndpoint)
	}
}

func TestEndToEndForwardToFakeOpenRouter(t *testing.T) {
	// Fake OpenRouter that captures the forwarded request and returns 401.
	var (
		gotAuth   string
		gotBody   []byte
		gotPath   string
		gotMethod string
	)
	fakeOR := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		gotPath = r.URL.Path
		gotMethod = r.Method
		gotBody, _ = io.ReadAll(r.Body)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = w.Write([]byte(`{"error":{"message":"User not found","code":401}}`))
	}))
	defer fakeOR.Close()

	cfg := &config.RouterConfig{
		BrickExtension: config.BrickExtension{
			Brick: config.BrickConfig{Enabled: true},
		},
		BackendModels: config.BackendModels{
			ModelConfig: map[string]config.ModelParams{
				"openai/gpt-4o-mini": {},
			},
		},
		SkillRouter: config.SkillRouterConfig{
			Enabled: true,
			Models: []config.SkillRouterModelConfig{
				{
					Model:   "openai/gpt-4o-mini",
					BaseURL: fakeOR.URL + "/api/v1",
					APIKey:  "sk-or-v1-test-fake-key",
					CustomParams: map[string]interface{}{
						"top_p": 0.95,
					},
				},
			},
		},
	}
	srv := &Server{cfg: cfg}

	body := `{"model":"brick","messages":[{"role":"user","content":"hi"}]}`
	req := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer client-bearer")
	req.Header.Set("x-selected-model", "openai/gpt-4o-mini")
	w := httptest.NewRecorder()

	srv.handleChatCompletions(w, req)

	resp := w.Result()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Errorf("response status = %d, want 401 (from fake OpenRouter)", resp.StatusCode)
	}
	if gotMethod != http.MethodPost {
		t.Errorf("fake OR received method = %q, want POST", gotMethod)
	}
	if gotPath != "/api/v1/chat/completions" {
		t.Errorf("fake OR received path = %q, want /api/v1/chat/completions", gotPath)
	}
	if gotAuth != "Bearer sk-or-v1-test-fake-key" {
		t.Errorf("fake OR received auth = %q, want resolved from model APIKey literal (not client bearer)", gotAuth)
	}
	if selected := resp.Header.Get("x-vsr-selected-model"); selected != "openai/gpt-4o-mini" {
		t.Errorf("response x-vsr-selected-model = %q, want openai/gpt-4o-mini", selected)
	}
	var sent map[string]interface{}
	if err := json.Unmarshal(gotBody, &sent); err != nil {
		t.Fatalf("forwarded body not JSON: %v", err)
	}
	if sent["model"] != "openai/gpt-4o-mini" {
		t.Errorf("forwarded body model = %v, want rewritten to selected", sent["model"])
	}
	if sent["top_p"] != 0.95 {
		t.Errorf("forwarded body top_p = %v, want merged from custom_params", sent["top_p"])
	}
}
