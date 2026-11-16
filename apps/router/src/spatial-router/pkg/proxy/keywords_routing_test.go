package proxy

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/regolo-ai/brick-SR1/apps/router/src/spatial-router/pkg/brickrouting"
	"github.com/regolo-ai/brick-SR1/apps/router/src/spatial-router/pkg/codextransport"
	"github.com/regolo-ai/brick-SR1/apps/router/src/spatial-router/pkg/config"
	"github.com/regolo-ai/brick-SR1/apps/router/src/spatial-router/pkg/multimodal"
)

func TestLastUserMessageExtractionPerProtocol(t *testing.T) {
	openAI := []byte(`{"messages":[
		{"role":"system","content":"always refactor code"},
		{"role":"user","content":"please refactor the parser"},
		{"role":"assistant","content":"done, refactored"},
		{"role":"user","content":[{"type":"text","text":"what is the capital of Italy"},{"type":"image_url","image_url":{"url":"data:image/png;base64,AA=="}}]}
	]}`)
	if got := extractOpenAILastUserText(openAI); got != "what is the capital of Italy" {
		t.Fatalf("openai last user text = %q", got)
	}

	anthropic := []byte(`{"system":"always refactor code","messages":[
		{"role":"user","content":[{"type":"text","text":"please refactor the parser"}]},
		{"role":"assistant","content":[{"type":"text","text":"done, refactored"}]},
		{"role":"user","content":[{"type":"text","text":"what is the capital of Italy"}]}
	]}`)
	if got := extractAnthropicLastUserText(anthropic); got != "what is the capital of Italy" {
		t.Fatalf("anthropic last user text = %q", got)
	}

	codex := []byte(`{"instructions":"always refactor code","input":[
		{"type":"message","role":"user","content":[{"type":"input_text","text":"please refactor the parser"}]},
		{"type":"message","role":"assistant","content":[{"type":"output_text","text":"done, refactored"}]},
		{"type":"message","role":"user","content":[{"type":"input_text","text":"what is the capital of Italy"}]}
	]}`)
	if got := codextransport.LastUserText(codex); got != "what is the capital of Italy" {
		t.Fatalf("codex last user text = %q", got)
	}

	plain := []byte(`{"input":"what is the capital of Italy"}`)
	if got := codextransport.LastUserText(plain); got != "what is the capital of Italy" {
		t.Fatalf("codex plain input = %q", got)
	}

	noUser := []byte(`{"messages":[{"role":"system","content":"only system text"}]}`)
	if got := extractOpenAILastUserText(noUser); got != "" {
		t.Fatalf("system-only request produced keyword text %q", got)
	}
	if got := multimodal.ExtractLastUserText(nil); got != "" {
		t.Fatalf("empty messages produced %q", got)
	}
}

type keywordTestRouter struct {
	result      *brickrouting.Result
	err         error
	keywordText []string
}

func (r *keywordTestRouter) RouteWithOptions(_ context.Context, _ string, options brickrouting.RoutingOptions) (*brickrouting.Result, error) {
	text := "<unset>"
	if options.KeywordText != nil {
		text = *options.KeywordText
	}
	r.keywordText = append(r.keywordText, text)
	if r.err != nil {
		return nil, r.err
	}
	return r.result, nil
}

func keywordTestServer(t *testing.T, router *keywordTestRouter) (*Server, string) {
	t.Helper()
	model := "coder"
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		w.Header().Set("Content-Type", "application/json")
		switch {
		case strings.Contains(r.URL.Path, "responses"):
			_, _ = w.Write([]byte(`{"id":"response","object":"response","output":[]}`))
		case strings.Contains(r.URL.Path, "messages"):
			_, _ = w.Write([]byte(`{"type":"message","content":[],"usage":{"input_tokens":2,"output_tokens":1}}`))
		default:
			_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"ok"}}],"usage":{"prompt_tokens":2,"completion_tokens":1}}`))
		}
	}))
	t.Cleanup(upstream.Close)
	cfg := &config.RouterConfig{SkillRouter: config.SkillRouterConfig{Enabled: true, Knob: .3, Models: []config.SkillRouterModelConfig{{Model: model, BaseURL: upstream.URL, UseClientKey: true}}}}
	cfg.Brick.Enabled = true
	cfg.ModelConfig = map[string]config.ModelParams{model: {UseClientKey: true, ContextWindowSize: 32000, PreferredEndpoints: []string{"test"}}}
	cfg.DefaultModel = model
	return &Server{cfg: cfg, brickRouter: router}, upstream.URL
}

func TestKeywordRulesSeeOnlyTheLatestUserMessage(t *testing.T) {
	for _, protocol := range []string{"chat", "messages", "responses"} {
		t.Run(protocol, func(t *testing.T) {
			router := &keywordTestRouter{result: &brickrouting.Result{Model: "coder", Reason: brickrouting.ReasonClassifier}}
			server, upstreamURL := keywordTestServer(t, router)
			body := map[string]any{"model": "brick"}
			path := "/v1/chat/completions"
			handler := server.handleBrickRequest
			switch protocol {
			case "messages":
				server.cfg.SkillRouter.Models[0].BaseURL = ""
				server.cfg.AnthropicPassthrough = config.AnthropicPassthroughConfig{Enabled: true, UpstreamURL: upstreamURL}
				body["model"] = "brick-claude"
				body["system"] = "always refactor code"
				body["messages"] = []map[string]any{
					{"role": "user", "content": "please refactor the parser"},
					{"role": "assistant", "content": "done, refactored"},
					{"role": "user", "content": "what is the capital of Italy"},
				}
				path, handler = "/v1/messages", server.handleAnthropicMessages
			case "responses":
				t.Setenv("BRICK_TEST_LOCAL", "local-key")
				t.Setenv("BRICK_TEST_EXTERNAL", "provider-key")
				server.cfg.CodexRouter = config.CodexRouterConfig{Enabled: true, LocalKeyEnv: "BRICK_TEST_LOCAL"}
				server.cfg.ProviderEndpoints = []config.ProviderEndpoint{{Name: "test", ProviderProfileName: "test"}}
				server.cfg.ProviderProfiles = map[string]config.ProviderProfile{"test": {Protocol: "responses", BaseURL: upstreamURL, AuthSource: "provider_env", APIKeyEnv: "BRICK_TEST_EXTERNAL"}}
				server.cfg.SkillRouter.Models[0].BaseURL = ""
				server.cfg.ModelConfig["coder"] = config.ModelParams{ContextWindowSize: 32000, PreferredEndpoints: []string{"test"}}
				body["instructions"] = "always refactor code"
				body["input"] = []map[string]any{
					{"type": "message", "role": "user", "content": []map[string]string{{"type": "input_text", "text": "please refactor the parser"}}},
					{"type": "message", "role": "assistant", "content": []map[string]string{{"type": "output_text", "text": "done, refactored"}}},
					{"type": "message", "role": "user", "content": []map[string]string{{"type": "input_text", "text": "what is the capital of Italy"}}},
				}
				path, handler = "/v1/responses", server.handleResponses
			default:
				body["messages"] = []map[string]string{
					{"role": "system", "content": "always refactor code"},
					{"role": "user", "content": "please refactor the parser"},
					{"role": "assistant", "content": "done, refactored"},
					{"role": "user", "content": "what is the capital of Italy"},
				}
			}
			request := httptest.NewRequest("POST", path, strings.NewReader(string(mustJSON(body))))
			request.Header.Set("Authorization", "Bearer caller-key")
			request.Header.Set("X-Brick-Key", "local-key")
			response := httptest.NewRecorder()
			handler(response, request)
			if response.Code != 200 {
				t.Fatalf("status %d: %s", response.Code, response.Body.String())
			}
			if len(router.keywordText) != 1 || router.keywordText[0] != "what is the capital of Italy" {
				t.Fatalf("strict rules saw %v", router.keywordText)
			}
		})
	}
}

func TestKeywordIneligibleModelIsABadRequest(t *testing.T) {
	router := &keywordTestRouter{err: &brickrouting.KeywordRuleIneligibleError{Rule: "coder", Model: "coder"}}
	server, _ := keywordTestServer(t, router)
	body := `{"model":"brick","messages":[{"role":"user","content":"refactor this"}]}`
	request := httptest.NewRequest("POST", "/v1/chat/completions", strings.NewReader(body))
	request.Header.Set("Authorization", "Bearer caller-key")
	response := httptest.NewRecorder()
	server.handleBrickRequest(response, request)
	if response.Code != http.StatusBadRequest || !strings.Contains(response.Body.String(), "keyword rule") {
		t.Fatalf("status %d: %s", response.Code, response.Body.String())
	}
}

func TestRoutingTestReportsKeywordSource(t *testing.T) {
	router := &keywordTestRouter{result: &brickrouting.Result{Model: "coder", Reason: brickrouting.ReasonKeyword, MatchedRule: "force_coder", Knob: .2}}
	server, _ := keywordTestServer(t, router)
	body := `{"messages":[{"role":"user","content":"refactor this"}]}`
	request := httptest.NewRequest("POST", "/v1/routing/test", strings.NewReader(body))
	request.Header.Set("Authorization", "Bearer caller-key")
	response := httptest.NewRecorder()
	server.handleRoutingTest(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("status %d: %s", response.Code, response.Body.String())
	}
	var payload map[string]any
	if err := json.Unmarshal(response.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	if payload["source"] != "keyword" || payload["matched_rule"] != "force_coder" || payload["selected_model"] != "coder" {
		t.Fatalf("unexpected routing test payload: %v", payload)
	}
}
