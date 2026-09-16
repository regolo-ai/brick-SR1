package proxy

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/regolo-ai/brick-SR1/apps/router/src/spatial-router/pkg/config"
)

func TestRegoloDeploymentFixedReasoning(t *testing.T) {
	for _, multimodal := range []bool{false, true} {
		for _, enabled := range []bool{false, true} {
			t.Run(fmt.Sprintf("multimodal=%v/reasoning=%v", multimodal, enabled), func(t *testing.T) {
				cfg, err := config.Parse("../../../../../../examples/regolo.config.yaml")
				if err != nil {
					t.Fatal(err)
				}
				cfg.SkillRouter.Models[0].UseReasoning = &enabled
				cfg.SkillRouter.Models[0].ReasoningEffort = "medium"
				cfg.SkillRouter.Models[0].HandlesImages = multimodal
				var calls atomic.Int32
				interceptRegolo(t, func(w http.ResponseWriter, r *http.Request) {
					calls.Add(1)
					var body map[string]any
					if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
						t.Error(err)
					}
					if enabled {
						if body["thinking"] != true || body["reasoning_effort"] != "medium" {
							t.Error("fixed per-model reasoning was not applied")
						}
					} else {
						for _, field := range []string{"thinking", "reasoning_effort", "chat_template_kwargs"} {
							if _, exists := body[field]; exists {
								t.Errorf("unsupported reasoning field %s forwarded", field)
							}
						}
					}
					for _, field := range []string{"max_tokens", "max_completion_tokens", "max_output_tokens"} {
						if _, exists := body[field]; exists {
							t.Errorf("inference injected %s", field)
						}
					}
					w.Header().Set("Content-Type", "application/json")
					fmt.Fprint(w, `{"choices":[{"message":{"content":"OK"},"finish_reason":"stop"}]}`)
				})
				content := `"hello"`
				if multimodal {
					content = `[{"type":"text","text":"describe this"},{"type":"image_url","image_url":{"url":"data:image/png;base64,aGVsbG8="}}]`
				}
				s := &Server{cfg: cfg, brickRouter: fixedAuthTestRouter{}}
				s.brickRouterOnce.Do(func() {})
				request := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", strings.NewReader(fmt.Sprintf(`{"model":"brick-v1-beta","thinking":true,"reasoning_effort":"high","messages":[{"role":"user","content":%s}]}`, content)))
				request.Header.Set("Authorization", "Bearer user-key")
				w := httptest.NewRecorder()
				s.handleChatCompletions(w, request)
				if w.Code != http.StatusOK || calls.Load() != 1 {
					t.Fatalf("status=%d calls=%d", w.Code, calls.Load())
				}
			})
		}
	}
}

type regoloWireTransport func(*http.Request) (*http.Response, error)

func (f regoloWireTransport) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

// Keep the production URL in the loaded configuration; replace only network I/O.
func interceptRegolo(t *testing.T, handler http.HandlerFunc) {
	t.Helper()
	upstream := httptest.NewServer(handler)
	t.Cleanup(upstream.Close)
	target, err := url.Parse(upstream.URL)
	if err != nil {
		t.Fatal(err)
	}
	original := http.DefaultTransport
	http.DefaultTransport = regoloWireTransport(func(r *http.Request) (*http.Response, error) {
		if r.URL.Hostname() != "api.regolo.ai" {
			if r.URL.Hostname() != "127.0.0.1" && r.URL.Hostname() != "::1" {
				return nil, fmt.Errorf("unexpected external request in authentication test")
			}
			return original.RoundTrip(r)
		}
		cloned := r.Clone(r.Context())
		cloned.URL.Scheme, cloned.URL.Host = target.Scheme, target.Host
		return original.RoundTrip(cloned)
	})
	originalAnthropic := anthropicHTTPClient
	clientCopy := *originalAnthropic
	clientCopy.Transport = http.DefaultTransport
	anthropicHTTPClient = &clientCopy
	t.Cleanup(func() { http.DefaultTransport = original; anthropicHTTPClient = originalAnthropic })
}

func TestRegoloLoadedDeploymentUsesCallerOverHTTP(t *testing.T) {
	t.Setenv("REGOLO_API_KEY", "server-decoy-key")
	var calls atomic.Int32
	interceptRegolo(t, func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		var body struct {
			Model string `json:"model"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Error(err)
		}
		expected := r.Header.Get("User-Agent")
		if expected != "user-a-key" && expected != "user-b-key" {
			t.Error("missing test request identity")
		}
		if r.Header.Get("Authorization") != "Bearer "+expected {
			t.Error("actual upstream authorization differs from caller key")
		}
		if r.URL.Path != "/v1/chat/completions" {
			t.Errorf("unexpected path %s", r.URL.Path)
		}
		if body.Model != "qwen3.5-9b" && body.Model != "qwen3.5-122b" && body.Model != "glm5.2" {
			t.Errorf("unexpected outbound model %q", body.Model)
		}
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{"id":"test","choices":[{"message":{"content":"OK"},"finish_reason":"stop"}]}`)
	})
	cfg, err := config.Parse("../../../../../../examples/regolo.config.yaml")
	if err != nil {
		t.Fatal(err)
	}
	// Do not repair or augment the deployment's gateway configuration in the test.
	s := &Server{cfg: cfg}
	for _, protocol := range []string{"chat", "responses"} {
		handler := s.handleChatCompletions
		if protocol == "responses" {
			handler = s.handleResponses
		}
		front := httptest.NewServer(http.HandlerFunc(handler))
		for _, model := range []string{"qwen3.5-9b", "qwen3.5-122b", "glm5.2"} {
			for _, user := range []string{"user-a-key", "user-b-key", ""} {
				payload := `{"model":"brick","messages":[{"role":"user","content":"hello"}]}`
				if protocol == "responses" {
					payload = `{"model":"brick","input":"hello"}`
				}
				req, _ := http.NewRequest(http.MethodPost, front.URL, strings.NewReader(payload))
				req.Header.Set("Authorization", "Bearer "+user)
				req.Header.Set("User-Agent", user)
				req.Header.Set("x-selected-model", model)
				resp, err := front.Client().Do(req)
				if err != nil {
					t.Fatal(err)
				}
				data, _ := io.ReadAll(resp.Body)
				resp.Body.Close()
				want := http.StatusOK
				if user == "" {
					want = http.StatusUnauthorized
				}
				if resp.StatusCode != want {
					t.Errorf("%s/%s: got %d, want %d: %s", protocol, model, resp.StatusCode, want, data)
				}
			}
		}
		front.Close()
	}
	if calls.Load() != 12 {
		t.Errorf("upstream calls=%d, want 12 authenticated requests", calls.Load())
	}
}

func TestRegoloAnthropicAdapterUsesCaller(t *testing.T) {
	var calls atomic.Int32
	interceptRegolo(t, func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		if r.Header.Get("Authorization") != "Bearer user-key" {
			t.Error("Anthropic adapter forwarded a server credential")
		}
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{"id":"test","choices":[{"message":{"content":"OK"},"finish_reason":"stop"}]}`)
	})
	cfg := &config.RouterConfig{}
	cfg.AnthropicPassthrough.Enabled = true
	cfg.SkillRouter.Models = []config.SkillRouterModelConfig{{Model: "qwen3.5-9b", BaseURL: "https://api.regolo.ai/v1", APIKey: "server-decoy-key", UseClientKey: true}}
	front := httptest.NewServer(http.HandlerFunc((&Server{cfg: cfg}).handleAnthropicMessages))
	defer front.Close()
	for _, header := range []string{"Authorization", "x-api-key", "missing"} {
		req, _ := http.NewRequest(http.MethodPost, front.URL, strings.NewReader(`{"model":"qwen3.5-9b","max_tokens":16,"messages":[{"role":"user","content":"hello"}]}`))
		if header == "Authorization" {
			req.Header.Set(header, "Bearer user-key")
		} else if header == "x-api-key" {
			req.Header.Set(header, "user-key")
		}
		resp, err := front.Client().Do(req)
		if err != nil {
			t.Fatal(err)
		}
		io.Copy(io.Discard, resp.Body)
		resp.Body.Close()
		want := http.StatusOK
		if header == "missing" {
			want = http.StatusUnauthorized
		}
		if resp.StatusCode != want {
			t.Errorf("%s: status=%d want=%d", header, resp.StatusCode, want)
		}
	}
	if calls.Load() != 2 {
		t.Errorf("adapter made %d upstream calls, want 2", calls.Load())
	}
}

func TestRegoloDeploymentPublicModelAndRejections(t *testing.T) {
	var calls atomic.Int32
	interceptRegolo(t, func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		if r.Header.Get("Authorization") == "Bearer rejected-key" {
			w.WriteHeader(http.StatusUnauthorized)
			fmt.Fprint(w, `{"error":{"message":"invalid API key"}}`)
			return
		}
		if r.Header.Get("Authorization") != "Bearer user-key" {
			t.Error("unexpected upstream credential")
		}
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{"model":"qwen3.5-9b","choices":[{"message":{"content":"OK"},"finish_reason":"stop"}]}`)
	})
	cfg, err := config.Parse("../../../../../../examples/regolo.config.yaml")
	if err != nil {
		t.Fatal(err)
	}
	s := &Server{cfg: cfg, brickRouter: fixedAuthTestRouter{}}
	s.brickRouterOnce.Do(func() {})
	catalog := httptest.NewRecorder()
	s.handleModels(catalog, httptest.NewRequest(http.MethodGet, "/v1/models", nil))
	var listed struct {
		Data []struct{ ID string }
	}
	if err := json.Unmarshal(catalog.Body.Bytes(), &listed); err != nil ||
		len(listed.Data) != 1 || listed.Data[0].ID != "brick-v1-beta" {
		t.Fatalf("deployment must advertise only its public Regolo model: %s", catalog.Body.String())
	}
	for _, tc := range []struct {
		model, selected, key string
		status               int
		forwarded            bool
	}{
		{"brick-v1-beta", "", "user-key", http.StatusOK, true},
		{"brick", "", "user-key", http.StatusOK, true},
		{"brick-v1-beta", "glm5.2", "user-key", http.StatusOK, true},
		{"brick-v1-beta", "", "", http.StatusUnauthorized, false},
		{"brick-v1-beta", "", "${REGOLO_API_KEY}", http.StatusUnauthorized, false},
		{"brick-v1-beta", "", "rejected-key", http.StatusUnauthorized, true},
		{"brick-v1-beta", "gpt-4o", "user-key", http.StatusBadRequest, false},
		{"brick-v1-beta", "claude-sonnet-4", "user-key", http.StatusBadRequest, false},
		{"brick-v1-beta", "glm5.2-beta", "user-key", http.StatusBadRequest, false},
		{"gpt-4o", "", "user-key", http.StatusBadRequest, false},
	} {
		t.Run(tc.model+"/"+tc.selected+"/"+tc.key, func(t *testing.T) {
			before := calls.Load()
			body := fmt.Sprintf(`{"model":%q,"messages":[{"role":"user","content":"hello"}]}`, tc.model)
			req := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", strings.NewReader(body))
			req.Header.Set("Authorization", "Bearer "+tc.key)
			req.Header.Set("x-selected-model", tc.selected)
			w := httptest.NewRecorder()
			s.handleChatCompletions(w, req)
			if w.Code != tc.status {
				t.Fatalf("status=%d, want %d: %s", w.Code, tc.status, w.Body.String())
			}
			wantCalls := int32(0)
			if tc.forwarded {
				wantCalls = 1
			}
			if calls.Load()-before != wantCalls {
				t.Fatal("unexpected upstream request count")
			}
			if tc.status == http.StatusOK {
				var result struct{ Model string }
				if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil || result.Model != tc.model {
					t.Fatalf("response did not preserve public model name: %s", w.Body.String())
				}
			}
		})
	}
}

func TestRegoloClientKeyOverridesCaseVariantExtraHeaders(t *testing.T) {
	cfg, err := config.Parse("../../../../../../examples/regolo.config.yaml")
	if err != nil {
		t.Fatal(err)
	}
	profile := cfg.ProviderProfiles["regolo"]
	profile.ExtraHeaders = map[string]string{"authorization": "Bearer server-decoy-key", "AUTHORIZATION": "Bearer another-server-key", "X-Deployment": "test"}
	cfg.ProviderProfiles["regolo"] = profile
	result := (&Server{cfg: cfg}).buildForwardResultForModel([]byte(`{"model":"brick"}`), cfg, "qwen3.5-9b", false, "user-key")
	count := 0
	for name, value := range result.ForwardHeaders {
		if strings.EqualFold(name, "Authorization") {
			count++
			if value != "Bearer user-key" {
				t.Error("server ExtraHeaders can overwrite the user credential")
			}
		}
	}
	if count != 1 {
		t.Errorf("got %d case-insensitive Authorization headers, want one", count)
	}
	interceptRegolo(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer user-key" {
			t.Error("upstream received server credential from ExtraHeaders")
		}
		if r.Header.Get("X-Deployment") != "test" {
			t.Error("unrelated provider header lost")
		}
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{"choices":[]}`)
	})
	req := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", strings.NewReader(`{"model":"brick"}`))
	req.Header.Set("Authorization", "Bearer user-key")
	(&Server{cfg: cfg}).forwardToBackend(httptest.NewRecorder(), req, result, "brick")
}
