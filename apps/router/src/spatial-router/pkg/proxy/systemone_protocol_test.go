package proxy

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/regolo-ai/brick-SR1/apps/router/src/spatial-router/pkg/brickrouting"
	"github.com/regolo-ai/brick-SR1/apps/router/src/spatial-router/pkg/config"
)

type optionsTestRouter struct {
	model   string
	options []brickrouting.RoutingOptions
	fail    bool
	text    string
}

func (router *optionsTestRouter) RouteWithOptions(_ context.Context, text string, options brickrouting.RoutingOptions) (*brickrouting.Result, error) {
	router.text = text
	router.options = append(router.options, options)
	if router.fail {
		return nil, errors.New("local inference failed")
	}
	return &brickrouting.Result{Model: router.model}, nil
}

// Exercise the actual HTTP handlers; generation backends are loopback test servers.
func TestSystemOneProtocolsPreserveEffortAndFailWithoutFallback(t *testing.T) {
	for _, protocol := range []string{"chat", "messages", "responses"} {
		for _, effort := range []string{"", "low", "medium", "high", "xhigh", "max"} {
			t.Run(protocol+"/"+effort, func(t *testing.T) {
				model := "claude-opus-4-8"
				calls := 0
				upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					calls++
					var body map[string]any
					_ = json.NewDecoder(r.Body).Decode(&body)
					if body["model"] != model || requestEffort(mustJSON(body)) != effort {
						t.Error("provider received a changed model or effort", body)
					}
					w.Header().Set("Content-Type", "application/json")
					if protocol == "responses" {
						fmt.Fprint(w, `{"id":"response","object":"response","output":[]}`)
					} else if protocol == "messages" {
						fmt.Fprint(w, `{"type":"message","content":[],"usage":{"input_tokens":2,"output_tokens":1}}`)
					} else {
						fmt.Fprint(w, `{"choices":[{"message":{"content":"ok"}}],"usage":{"prompt_tokens":2,"completion_tokens":1}}`)
					}
				}))
				defer upstream.Close()
				cfg := &config.RouterConfig{SkillRouter: config.SkillRouterConfig{Enabled: true, Knob: .3, Models: []config.SkillRouterModelConfig{{Model: model, BaseURL: upstream.URL, UseClientKey: true}}}}
				cfg.Brick.Enabled = true
				cfg.ModelConfig = map[string]config.ModelParams{model: {UseClientKey: true, ContextWindowSize: 32000, PreferredEndpoints: []string{"test"}}}
				cfg.DefaultModel = model
				router := &optionsTestRouter{model: model}
				server := &Server{cfg: cfg, brickRouter: router}
				body := map[string]any{"model": "brick", "messages": []map[string]string{{"role": "user", "content": "same query"}}}
				path := "/v1/chat/completions"
				handler := server.handleBrickRequest
				switch protocol {
				case "messages":
					cfg.SkillRouter.Models[0].BaseURL = ""
					cfg.AnthropicPassthrough = config.AnthropicPassthroughConfig{Enabled: true, UpstreamURL: upstream.URL}
					body["model"] = "brick-claude"
					path = "/v1/messages"
					handler = server.handleAnthropicMessages
					if effort != "" {
						body["output_config"] = map[string]string{"effort": effort}
					}
				case "responses":
					t.Setenv("BRICK_TEST_LOCAL", "local-key")
					t.Setenv("BRICK_TEST_EXTERNAL", "provider-key")
					cfg.CodexRouter = config.CodexRouterConfig{Enabled: true, LocalKeyEnv: "BRICK_TEST_LOCAL"}
					cfg.ProviderEndpoints = []config.ProviderEndpoint{{Name: "test", ProviderProfileName: "test"}}
					cfg.ProviderProfiles = map[string]config.ProviderProfile{"test": {Protocol: "responses", BaseURL: upstream.URL, AuthSource: "provider_env", APIKeyEnv: "BRICK_TEST_EXTERNAL"}}
					cfg.SkillRouter.Models[0].BaseURL = ""
					cfg.ModelConfig[model] = config.ModelParams{ContextWindowSize: 32000, PreferredEndpoints: []string{"test"}}
					delete(body, "messages")
					body["input"] = []map[string]string{{"role": "user", "content": "same query"}}
					path = "/v1/responses"
					handler = server.handleResponses
					if effort != "" {
						body["reasoning"] = map[string]string{"effort": effort}
					}
				default:
					if effort != "" {
						body["reasoning_effort"] = effort
					}
				}
				send := func() *httptest.ResponseRecorder {
					request := httptest.NewRequest("POST", path, strings.NewReader(string(mustJSON(body))))
					request.Header.Set("Authorization", "Bearer caller-key")
					request.Header.Set("X-Brick-Key", "local-key")
					response := httptest.NewRecorder()
					handler(response, request)
					return response
				}
				response := send()
				if response.Code != 200 || calls != 1 || len(router.options) != 1 {
					t.Fatal(response.Code, response.Body.String(), calls, len(router.options))
				}
				if router.text != "same query" {
					t.Fatal("protocol wrapper changed the SystemOne query", router.text)
				}
				options := router.options[0]
				if effort == "" && options.Knob != nil {
					t.Fatal("absent effort replaced the profile knob")
				}
				if effort != "" && (options.Knob == nil || *options.Knob != effortKnob(effort)) {
					t.Fatal("effort override lost", options)
				}
				router.fail = true
				response = send()
				if response.Code < 500 || calls != 1 {
					t.Fatal("inference failure generated a fallback request", response.Code, calls)
				}
			})
		}
	}
}

func mustJSON(value any) []byte {
	encoded, err := json.Marshal(value)
	if err != nil {
		panic(err)
	}
	return encoded
}

func TestFixedModelsBypassUnavailableSystemOneAcrossProtocols(t *testing.T) {
	for _, protocol := range []string{"chat", "messages", "responses"} {
		t.Run(protocol, func(t *testing.T) {
			model := "claude-opus-4-8"
			calls := 0
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls++
				w.Header().Set("Content-Type", "application/json")
				fmt.Fprint(w, `{"id":"test","output":[],"choices":[{"message":{"content":"ok"}}],"content":[]}`)
			}))
			defer upstream.Close()
			disabled := false
			cfg := &config.RouterConfig{SkillRouter: config.SkillRouterConfig{Enabled: true, Models: []config.SkillRouterModelConfig{{Model: model, BaseURL: upstream.URL, UseClientKey: true}}}}
			cfg.Brick = config.BrickConfig{Enabled: true, UseModelRouting: &disabled, FixedModel: model}
			cfg.DefaultModel = model
			cfg.ModelConfig = map[string]config.ModelParams{model: {UseClientKey: true, ContextWindowSize: 32000, PreferredEndpoints: []string{"test"}}}
			router := &optionsTestRouter{model: model, fail: true}
			server := &Server{cfg: cfg, brickRouter: router}
			path := "/v1/chat/completions"
			body := `{"model":"brick","reasoning_effort":"high","messages":[{"role":"user","content":"query"}]}`
			handler := server.handleBrickRequest
			if protocol == "messages" {
				cfg.AnthropicPassthrough = config.AnthropicPassthroughConfig{Enabled: true, UpstreamURL: upstream.URL, UseModelRouting: &disabled, FixedModel: model}
				cfg.SkillRouter.Models[0].BaseURL = ""
				path = "/v1/messages"
				body = `{"model":"brick-claude","messages":[{"role":"user","content":"query"}]}`
				handler = server.handleAnthropicMessages
			} else if protocol == "responses" {
				t.Setenv("BRICK_TEST_LOCAL", "local")
				t.Setenv("BRICK_TEST_EXTERNAL", "external")
				cfg.CodexRouter = config.CodexRouterConfig{Enabled: true, LocalKeyEnv: "BRICK_TEST_LOCAL"}
				cfg.ProviderEndpoints = []config.ProviderEndpoint{{Name: "test", ProviderProfileName: "test"}}
				cfg.ProviderProfiles = map[string]config.ProviderProfile{"test": {Protocol: "responses", BaseURL: upstream.URL, AuthSource: "provider_env", APIKeyEnv: "BRICK_TEST_EXTERNAL"}}
				cfg.SkillRouter.Models[0].BaseURL = ""
				cfg.ModelConfig[model] = config.ModelParams{ContextWindowSize: 32000, PreferredEndpoints: []string{"test"}}
				path = "/v1/responses"
				body = `{"model":"brick","input":"query"}`
				handler = server.handleResponses
			}
			request := httptest.NewRequest("POST", path, strings.NewReader(body))
			request.Header.Set("Authorization", "Bearer caller")
			request.Header.Set("X-Brick-Key", "local")
			response := httptest.NewRecorder()
			handler(response, request)
			if response.Code != 200 || calls != 1 || len(router.options) != 0 {
				t.Fatal("fixed model depended on inference", response.Code, response.Body.String(), calls, len(router.options))
			}
		})
	}
}
