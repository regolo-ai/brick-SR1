package proxy

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/regolo-ai/brick-SR1/apps/router/src/spatial-router/pkg/brickrouting"
	"github.com/regolo-ai/brick-SR1/apps/router/src/spatial-router/pkg/config"
)

type fixedAuthTestRouter struct{}

func (fixedAuthTestRouter) RouteWithCandidates(ctx context.Context, _ string, allowed map[string]bool) (*brickrouting.Result, error) {
	if config.ClientAPIKey(ctx) == "" {
		return nil, fmt.Errorf("request credential was not propagated to routing")
	}
	if allowed != nil && !allowed["qwen3.5-9b"] {
		return nil, fmt.Errorf("test model is outside candidate pool")
	}
	return &brickrouting.Result{Model: "qwen3.5-9b", Reason: "test", ComplexityLabel: "medium"}, nil
}

func (r fixedAuthTestRouter) RouteWithPreference(ctx context.Context, text string, _ float64) (*brickrouting.Result, error) {
	return r.RouteWithCandidates(ctx, text, nil)
}

func TestRegoloAuthorizationThroughHandlers(t *testing.T) {
	for _, path := range []string{"standard", "selected", "multimodal", "vision-direct", "inline", "legacy"} {
		for _, stream := range []bool{false, true} {
			for _, credential := range []string{"client-key", "second-user-key", "", "  ", "${REGOLO_API_KEY}"} {
				t.Run(fmt.Sprintf("%s/stream=%v/key=%q", path, stream, credential), func(t *testing.T) {
					t.Setenv("REGOLO_API_KEY", "server-key-must-not-be-used")
					var calls atomic.Int32
					upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
						calls.Add(1)
						if got := r.Header.Get("Authorization"); got != "Bearer "+credential {
							t.Errorf("upstream received wrong authorization: %q", got)
						}
						if r.URL.Path != "/v1/chat/completions" {
							t.Errorf("unexpected upstream path: %s", r.URL.Path)
						}
						if stream {
							w.Header().Set("Content-Type", "text/event-stream")
							fmt.Fprint(w, "data: {\"choices\":[]}\n\ndata: [DONE]\n\n")
						} else {
							w.Header().Set("Content-Type", "application/json")
							fmt.Fprint(w, `{"choices":[{"message":{"content":"ok"}}]}`)
						}
					}))
					defer upstream.Close()
					cfg := &config.RouterConfig{
						BrickExtension: config.BrickExtension{Brick: config.BrickConfig{Enabled: true}},
						BackendModels: config.BackendModels{
							ModelConfig: map[string]config.ModelParams{"qwen3.5-9b": {
								PreferredEndpoints: []string{"private-gateway"}, AccessKeyEnv: "REGOLO_API_KEY",
							}},
							ProviderProfiles:  map[string]config.ProviderProfile{"regolo": {Type: "openai_compatible", BaseURL: upstream.URL + "/v1"}},
							ProviderEndpoints: []config.ProviderEndpoint{{Name: "private-gateway", ProviderProfileName: "regolo"}},
						},
						SkillRouter: config.SkillRouterConfig{Enabled: true, Models: []config.SkillRouterModelConfig{{Model: "qwen3.5-9b"}}},
					}
					if path == "inline" {
						cfg.SkillRouter.Models[0].BaseURL = upstream.URL + "/v1"
					}
					if path == "legacy" {
						cfg.ProviderProfiles = nil
						cfg.ProviderEndpoints = nil
						// Override only the legacy destination; credentials still come from the current request.
						cfg.Providers = map[string]*config.ProviderConfig{"regoloai": {BaseURL: upstream.URL + "/v1"}}
					}
					content := `"hello"`
					if path == "multimodal" || path == "vision-direct" {
						content = `[{"type":"text","text":"describe this"},{"type":"image_url","image_url":{"url":"data:image/png;base64,aGVsbG8="}}]`
						cfg.SkillRouter.Models[0].HandlesImages = path == "multimodal"
						cfg.Brick.VisionModel = "qwen3.5-9b"
						cfg.Brick.VisionEndpoint = upstream.URL + "/v1/chat/completions"
					}
					srv := &Server{cfg: cfg, brickRouter: fixedAuthTestRouter{}}
					srv.brickRouterOnce.Do(func() {})
					body := fmt.Sprintf(`{"model":"brick","stream":%v,"messages":[{"role":"user","content":%s}]}`, stream, content)
					req := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", strings.NewReader(body))
					req.Header.Set("Authorization", "Bearer "+credential)
					if path == "selected" {
						req.Header.Set("x-selected-model", "qwen3.5-9b")
					}
					w := httptest.NewRecorder()
					srv.handleChatCompletions(w, req)
					if credential == "client-key" || credential == "second-user-key" {
						if w.Code != http.StatusOK || calls.Load() != 1 {
							t.Fatalf("expected one successful request, status=%d calls=%d body=%s", w.Code, calls.Load(), w.Body.String())
						}
						if path == "multimodal" && w.Header().Get("x-brick-route-reason") != "multimodal_passthrough" {
							t.Fatal("request did not exercise multimodal passthrough")
						}
					} else if w.Code != http.StatusUnauthorized || calls.Load() != 0 {
						t.Fatalf("invalid credential must fail without forwarding: status=%d calls=%d", w.Code, calls.Load())
					}
					if strings.Contains(w.Body.String(), "client-key") || strings.Contains(w.Body.String(), "server-key") {
						t.Fatal("response exposes credentials")
					}
				})
			}
		}
	}
}

func TestRegoloWithoutServerCredentialUsesClient(t *testing.T) {
	for _, endpoint := range []string{"https://api.regolo.ai/v1", "http://private-gateway/v1"} {
		cfg := &config.RouterConfig{BackendModels: config.BackendModels{
			ModelConfig:       map[string]config.ModelParams{"model": {PreferredEndpoints: []string{"gateway"}}},
			ProviderProfiles:  map[string]config.ProviderProfile{"regolo": {Type: "openai_compatible", BaseURL: endpoint}},
			ProviderEndpoints: []config.ProviderEndpoint{{Name: "gateway", ProviderProfileName: "regolo"}},
		}}
		for _, inline := range []bool{false, true} {
			if inline {
				cfg.SkillRouter.Models = []config.SkillRouterModelConfig{{Model: "model", BaseURL: endpoint}}
			}
			result := (&Server{}).buildForwardResultForModel([]byte(`{"model":"model"}`), cfg, "model", false, "client-key")
			if result.Direct || result.ForwardHeaders["Authorization"] != "Bearer client-key" {
				t.Fatal("Regolo must use the client key without a server credential")
			}
		}
	}
}

func TestClassifierProbeRejectsUnresolvedCredential(t *testing.T) {
	t.Setenv("REGOLO_API_KEY", "${REGOLO_API_KEY}")
	var calls atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		w.WriteHeader(http.StatusOK)
	}))
	defer upstream.Close()
	cfg := &config.RouterConfig{}
	cfg.ComplexityService = &config.ComplexityServiceConfig{
		Enabled: true, Protocol: "openai", BaseURL: upstream.URL, BearerToken: "${REGOLO_API_KEY}",
	}
	w := httptest.NewRecorder()
	(&Server{cfg: cfg}).handleDiagClassifier(w, httptest.NewRequest(http.MethodGet, "/diag/classifier", nil))
	if calls.Load() != 0 || !strings.Contains(w.Body.String(), `"reachable":false`) {
		t.Fatalf("probe must reject invalid credentials before contacting upstream: %s", w.Body.String())
	}
}

func TestClassifierProbeUsesClientCredential(t *testing.T) {
	for _, key := range []string{"client-key", ""} {
		t.Run(key, func(t *testing.T) {
			var calls atomic.Int32
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				if r.Header.Get("Authorization") != "Bearer client-key" {
					t.Error("probe must use caller credential")
				}
				fmt.Fprint(w, `{"data":[]}`)
			}))
			defer upstream.Close()
			cfg := &config.RouterConfig{}
			cfg.ComplexityService = &config.ComplexityServiceConfig{
				Enabled: true, Protocol: "openai", BaseURL: upstream.URL, UseClientKey: true, BearerToken: "server-key",
			}
			req := httptest.NewRequest(http.MethodGet, "/diag/classifier", nil)
			req.Header.Set("Authorization", "Bearer "+key)
			w := httptest.NewRecorder()
			(&Server{cfg: cfg}).handleDiagClassifier(w, req)
			if key != "" && (calls.Load() != 1 || !strings.Contains(w.Body.String(), `"reachable":true`)) {
				t.Fatal("authenticated probe did not reach upstream")
			}
			if key == "" && calls.Load() != 0 {
				t.Fatal("probe must not substitute the server credential")
			}
		})
	}
}
