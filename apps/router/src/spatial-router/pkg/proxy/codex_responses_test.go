package proxy

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"github.com/regolo-ai/brick-SR1/apps/router/src/spatial-router/pkg/brickrouting"
	"github.com/regolo-ai/brick-SR1/apps/router/src/spatial-router/pkg/codextransport"
	"github.com/regolo-ai/brick-SR1/apps/router/src/spatial-router/pkg/config"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus/testutil"
	"github.com/regolo-ai/brick-SR1/apps/router/src/spatial-router/pkg/observability/metrics"
)

type codexTestRouter struct{ calls atomic.Int32 }

type mixedLiveRouter struct{}

func (mixedLiveRouter) RouteWithCandidates(_ context.Context, text string, allow map[string]bool) (*brickrouting.Result, error) {
	model := "terra-live"
	lines := strings.Split(text, "\n")
	for index := len(lines) - 1; index >= 0; index-- {
		if !strings.Contains(lines[index], `"role":"user"`) {
			continue
		}
		if strings.Contains(lines[index], "regolo-second") {
			model = "regolo-live"
		}
		break
	}
	if !allow[model] {
		return nil, fmt.Errorf("selected model %s is unavailable", model)
	}
	return &brickrouting.Result{Model: model, TauQuery: 0.5}, nil
}
func (m mixedLiveRouter) RouteWithPreference(ctx context.Context, text string, _ float64) (*brickrouting.Result, error) {
	return m.RouteWithCandidates(ctx, text, map[string]bool{"terra-live": true, "regolo-live": true})
}

type captureResponseWriter struct {
	http.ResponseWriter
	body bytes.Buffer
}

func (w *captureResponseWriter) Write(p []byte) (int, error) {
	w.body.Write(p)
	return w.ResponseWriter.Write(p)
}
func (w *captureResponseWriter) Flush() {
	if f, ok := w.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

func (c *codexTestRouter) RouteWithCandidates(ctx context.Context, text string, allow map[string]bool) (*brickrouting.Result, error) {
	if config.ClientAPIKey(ctx) != "" {
		return nil, fmt.Errorf("session token leaked to classifier")
	}
	c.calls.Add(1)
	model := "first"
	if strings.Contains(text, "function_call_output") {
		model = "second"
	}
	if !allow[model] {
		return nil, fmt.Errorf("incompatible candidate")
	}
	label := "easy"
	if model == "second" {
		label = "hard"
	}
	return &brickrouting.Result{Model: model, ComplexityLabel: label, TauQuery: 0.6}, nil
}
func (c *codexTestRouter) RouteWithPreference(ctx context.Context, text string, _ float64) (*brickrouting.Result, error) {
	return c.RouteWithCandidates(ctx, text, nil)
}
func codexTestConfig(endpoint string) *config.RouterConfig {
	cfg := &config.RouterConfig{CodexRouter: config.CodexRouterConfig{Enabled: true, LocalKeyEnv: "BRICK_TEST_LOCAL"}}
	cfg.ModelConfig = map[string]config.ModelParams{"first": {PreferredEndpoints: []string{"external"}, ContextWindowSize: 128000}, "second": {PreferredEndpoints: []string{"external"}, ContextWindowSize: 128000}}
	cfg.ProviderEndpoints = []config.ProviderEndpoint{{Name: "external", ProviderProfileName: "external"}}
	cfg.ProviderProfiles = map[string]config.ProviderProfile{"external": {BaseURL: endpoint, Protocol: "responses", AuthSource: "provider_env", APIKeyEnv: "BRICK_TEST_EXTERNAL", Capabilities: []string{"function_tools"}}}
	cfg.SkillRouter.Models = []config.SkillRouterModelConfig{{Model: "first"}, {Model: "second"}}
	return cfg
}
func TestCodexDynamicToolCycle(t *testing.T) {
	metrics.ResetBrickCC()
	t.Cleanup(metrics.ResetBrickCC)
	t.Setenv("BRICK_TEST_LOCAL", "local")
	t.Setenv("BRICK_TEST_EXTERNAL", "external")
	var count atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer external" || r.Header.Get("X-Brick-Key") != "" {
			t.Error("credential leak")
		}
		body, _ := io.ReadAll(r.Body)
		var raw map[string]any
		json.Unmarshal(body, &raw)
		if raw["instructions"] != "keep rules" {
			t.Error("lost instructions")
		}
		count.Add(1)
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, `{"id":"response","object":"response","output":[]}`)
	}))
	defer upstream.Close()
	cfg := codexTestConfig(upstream.URL)
	cfg.SkillRouter.DynamicEffort = true
	s := &Server{cfg: cfg}
	router := &codexTestRouter{}
	s.brickRouter = router
	s.brickRouterOnce.Do(func() {})
	for i, input := range []string{`[{"role":"user","content":"do work"}]`, `[{"role":"user","content":"do work"},{"type":"function_call","call_id":"a","name":"shell","arguments":"{}"},{"type":"function_call_output","call_id":"a","output":"done"}]`} {
		r := httptest.NewRequest("POST", "/v1/responses", strings.NewReader(`{"model":"brick","instructions":"keep rules","input":`+input+`}`))
		r.Header.Set("X-Brick-Key", "local")
		r.Header.Set("Authorization", "Bearer codex-secret")
		w := httptest.NewRecorder()
		s.handleResponses(w, r)
		if w.Code != 200 {
			t.Fatal(w.Code, w.Body.String())
		}
		want := "first"
		if i == 1 {
			want = "second"
		}
		if w.Header().Get("X-Brick-Selected-Model") != want {
			t.Fatal("route was not reevaluated")
		}
	}
	if router.calls.Load() != 2 || count.Load() != 2 {
		t.Fatal("missing inference calls")
	}
	if got := testutil.ToFloat64(metrics.BrickCCRequests.WithLabelValues("easy", "first")); got != 1 {
		t.Fatalf("first routed request count = %v, want 1", got)
	}
	if got := testutil.ToFloat64(metrics.BrickCCRequests.WithLabelValues("hard", "second")); got != 1 {
		t.Fatalf("tool-result follow-up count = %v, want 1", got)
	}
	if got := testutil.ToFloat64(metrics.BrickCCEffort.WithLabelValues("first", "low")); got != 1 {
		t.Fatalf("first dynamic effort count = %v, want 1", got)
	}
	if got := testutil.ToFloat64(metrics.BrickCCRouting.WithLabelValues("hard", "low", "second")); got != 1 {
		t.Fatalf("follow-up routing count = %v, want 1", got)
	}
	r := httptest.NewRequest("POST", "/v1/responses", strings.NewReader(`{"model":"first","instructions":"keep rules","reasoning":{"effort":"high"},"input":"hi"}`))
	r.Header.Set("X-Brick-Key", "local")
	w := httptest.NewRecorder()
	s.handleResponses(w, r)
	if w.Code != 200 || router.calls.Load() != 2 || w.Header().Get("X-Brick-Reasoning-Sent") != "high" {
		t.Fatal("manual model was routed", w.Body.String())
	}
	if got := testutil.ToFloat64(metrics.BrickCCRequests.WithLabelValues("native", "first")); got != 1 {
		t.Fatalf("explicit model request count = %v, want 1", got)
	}
}

func TestCodexRejectedRequestsDoNotIncrementMetrics(t *testing.T) {
	metrics.ResetBrickCC()
	t.Cleanup(metrics.ResetBrickCC)
	t.Setenv("BRICK_TEST_LOCAL", "local")
	t.Setenv("BRICK_TEST_EXTERNAL", "external")

	cfg := codexTestConfig("http://127.0.0.1:1")
	s := &Server{cfg: cfg}

	requests := []*http.Request{
		httptest.NewRequest("POST", "/v1/responses", strings.NewReader(`{"model":"first","input":"hi"}`)),
		httptest.NewRequest("POST", "/v1/responses", strings.NewReader(`{"model":"first","input":"hi","tools":[{"type":"custom","name":"shell"}]}`)),
	}
	requests[0].Header.Set("X-Brick-Key", "wrong")
	requests[1].Header.Set("X-Brick-Key", "local")
	for _, request := range requests {
		w := httptest.NewRecorder()
		s.handleResponses(w, request)
		if w.Code < 400 || w.Code >= 500 {
			t.Fatalf("rejected request returned %d", w.Code)
		}
	}
	profile := cfg.ProviderProfiles["external"]
	profile.Protocol = "chat_completions"
	cfg.ProviderProfiles["external"] = profile
	preparationFailure := httptest.NewRequest("POST", "/v1/responses", strings.NewReader(`{"model":"first","input":"hi","unknown_field":true}`))
	preparationFailure.Header.Set("X-Brick-Key", "local")
	w := httptest.NewRecorder()
	s.handleResponses(w, preparationFailure)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("adapter preparation failure returned %d", w.Code)
	}
	if got := testutil.CollectAndCount(metrics.BrickCCRequests); got != 0 {
		t.Fatalf("rejected requests created %d metric series", got)
	}
}

func TestCodexChatAdapterRecordsRoutedRequest(t *testing.T) {
	metrics.ResetBrickCC()
	t.Cleanup(metrics.ResetBrickCC)
	t.Setenv("BRICK_TEST_LOCAL", "local")
	t.Setenv("BRICK_TEST_EXTERNAL", "external")

	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, `{"id":"chat","object":"chat.completion","choices":[{"index":0,"message":{"role":"assistant","content":"ok"},"finish_reason":"stop"}]}`)
	}))
	defer upstream.Close()

	cfg := codexTestConfig(upstream.URL)
	profile := cfg.ProviderProfiles["external"]
	profile.Protocol = "chat_completions"
	cfg.ProviderProfiles["external"] = profile
	s := &Server{cfg: cfg, brickRouter: &codexTestRouter{}}
	s.brickRouterOnce.Do(func() {})

	r := httptest.NewRequest("POST", "/v1/responses", strings.NewReader(`{"model":"brick","input":"hi"}`))
	r.Header.Set("X-Brick-Key", "local")
	w := httptest.NewRecorder()
	s.handleResponses(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("chat adapter returned %d: %s", w.Code, w.Body.String())
	}
	if got := testutil.ToFloat64(metrics.BrickCCRequests.WithLabelValues("easy", "first")); got != 1 {
		t.Fatalf("chat-adapted routed request count = %v, want 1", got)
	}
}

// Explicit opt-in: the installed official Codex owns login and tool execution.
func TestCodexOfficialLiveFileEdit(t *testing.T) {
	if os.Getenv("BRICK_CODEX_LIVE_TEST") != "1" {
		t.Skip("set BRICK_CODEX_LIVE_TEST=1 for the explicit subscription integration test")
	}
	t.Setenv("BRICK_TEST_LOCAL", "local-live")
	cfg := codexTestConfig("")
	model := "gpt-5.6-terra"
	cfg.ModelConfig = map[string]config.ModelParams{model: {PreferredEndpoints: []string{"codex"}}}
	cfg.ProviderEndpoints = []config.ProviderEndpoint{{Name: "codex", ProviderProfileName: "openai-codex"}}
	cfg.ProviderProfiles = map[string]config.ProviderProfile{"openai-codex": {BaseURL: "https://chatgpt.com/backend-api/codex", Protocol: "responses", AuthSource: "codex_request", CompactPath: "responses/compact", Capabilities: []string{"function_tools", "custom_tools", "opaque_reasoning", "compaction", "multimodal", "item:tool_search", "item:web_search", "item:additional_tools", "item:namespace"}}}
	s := &Server{cfg: cfg}
	var calls atomic.Int32
	var compactions atomic.Int32
	local := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/compact") {
			compactions.Add(1)
		}
		calls.Add(1)
		s.handleResponses(w, r)
	}))
	defer local.Close()
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "sum.py"), []byte("def add(a, b):\n    return a - b\n"), 0600)
	os.WriteFile(filepath.Join(dir, "test_sum.py"), []byte("import unittest\nfrom sum import add\nclass TestAdd(unittest.TestCase):\n    def test_add(self):\n        self.assertEqual(add(2, 3), 5)\n"), 0600)
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	provider := fmt.Sprintf(`model_providers.brick={name="Brick live test",base_url=%q,wire_api="responses",requires_openai_auth=true,supports_websockets=false,http_headers={"X-Brick-Key"="local-live"},request_max_retries=0,stream_max_retries=0}`, local.URL+"/v1")
	home := os.Getenv("CODEX_HOME")
	if home == "" {
		home = filepath.Join(os.Getenv("HOME"), ".codex")
	}
	cmd := exec.CommandContext(ctx, "codex", "exec", "--ignore-user-config", "--ephemeral", "--skip-git-repo-check", "--sandbox", "workspace-write", "-C", dir, "-m", model, "-c", `model_provider="brick"`, "-c", `model_reasoning_effort="medium"`, "-c", fmt.Sprintf("model_catalog_json=%q", filepath.Join(home, "models_cache.json")), "-c", provider, "Fix sum.py so add performs addition. Run python3 -m unittest test_sum.py and report the result. Use tools to edit and test the actual files.")

	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("official Codex failed: %v\n%s", err, out)
	}
	verify := exec.Command("python3", "-m", "unittest", "test_sum.py")
	verify.Dir = dir
	if out, err := verify.CombinedOutput(); err != nil {
		t.Fatalf("workspace test failed: %v %s", err, out)
	}
	if calls.Load() < 2 {
		t.Fatal("no tool-result inference follow-up")
	}

	t.Logf("compaction calls=%d", compactions.Load())
	t.Logf("official Codex edited the temporary project; tests passed; inference calls=%d", calls.Load())
}

func TestCodexRegoloLiveToolCycle(t *testing.T) {
	if os.Getenv("BRICK_REGOLO_LIVE_TEST") != "1" {
		t.Skip("set BRICK_REGOLO_LIVE_TEST=1 with BRICK_TEST_EXTERNAL for explicit external integration")
	}
	t.Setenv("BRICK_TEST_LOCAL", "local")
	cfg := codexTestConfig("https://api.regolo.ai/v1")
	p := cfg.ProviderProfiles["external"]
	p.Protocol = "chat_completions"
	cfg.ProviderProfiles["external"] = p
	cfg.ModelConfig["first"] = config.ModelParams{PreferredEndpoints: []string{"external"}, UpstreamModel: "qwen3.5-122b"}
	s := &Server{cfg: cfg}
	input := []any{map[string]any{"role": "user", "content": "Call add with a=2 and b=3. Then report the tool result."}}
	invoke := func(choice string) map[string]any {
		body, _ := json.Marshal(map[string]any{"model": "first", "input": input, "tools": []any{map[string]any{"type": "function", "name": "add", "description": "Add integers", "parameters": map[string]any{"type": "object", "properties": map[string]any{"a": map[string]any{"type": "integer"}, "b": map[string]any{"type": "integer"}}, "required": []string{"a", "b"}}}}, "tool_choice": choice, "reasoning": map[string]any{"effort": "none"}})
		r := httptest.NewRequest("POST", "/v1/responses", strings.NewReader(string(body)))
		r.Header.Set("X-Brick-Key", "local")
		r.Header.Set("Authorization", "Bearer synthetic-codex-token-must-not-leave")
		w := httptest.NewRecorder()
		s.handleResponses(w, r)
		if w.Code != 200 {
			t.Fatalf("external request failed %d: %s", w.Code, w.Body.String())
		}
		var result map[string]any
		if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil {
			t.Fatal(err)
		}
		return result
	}
	result := invoke("required")
	calls := 0
	for _, v := range result["output"].([]any) {
		item := v.(map[string]any)
		if item["type"] != "function_call" {
			t.Fatalf("unexpected output type %v", item["type"])
		}
		if item["name"] != "add" {
			t.Fatal("unexpected function")
		}
		var args struct {
			A int `json:"a"`
			B int `json:"b"`
		}
		if err := json.Unmarshal([]byte(item["arguments"].(string)), &args); err != nil {
			t.Fatal(err)
		}
		input = append(input, item, map[string]any{"type": "function_call_output", "call_id": item["call_id"], "output": fmt.Sprint(args.A + args.B)})
		calls++
	}
	if calls == 0 {
		t.Fatal("provider did not call a tool")
	}
	result = invoke("none")
	encoded, _ := json.Marshal(result["output"])
	if !strings.Contains(string(encoded), "5") {
		t.Fatal("tool result missing from final response")
	}
	t.Log("external function call, local execution, result, and final response passed")
}

func TestCodexOfficialRegoloLiveCustomTool(t *testing.T) {
	if os.Getenv("BRICK_REGOLO_LIVE_TEST") != "1" {
		t.Skip("set BRICK_REGOLO_LIVE_TEST=1 with BRICK_TEST_EXTERNAL for the official Codex external integration")
	}
	t.Setenv("BRICK_TEST_LOCAL", "local-regolo-live")
	cfg := codexTestConfig("https://api.regolo.ai/v1")
	profile := cfg.ProviderProfiles["external"]
	profile.Protocol = "chat_completions"
	cfg.ProviderProfiles["external"] = profile
	cfg.ModelConfig = map[string]config.ModelParams{"regolo-live": {PreferredEndpoints: []string{"external"}, UpstreamModel: "qwen3.5-122b", ContextWindowSize: 262000}}
	cfg.SkillRouter.Models = []config.SkillRouterModelConfig{{Model: "regolo-live"}}
	s := &Server{cfg: cfg}
	var calls atomic.Int32
	var customDeclarations atomic.Int32
	var requestShape atomic.Value
	local := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		if bytes.Contains(body, []byte(`"type":"custom"`)) || bytes.Contains(body, []byte(`"type": "custom"`)) {
			customDeclarations.Add(1)
		}
		r.Body = io.NopCloser(bytes.NewReader(body))
		if adapted, adaptErr := codextransport.PrepareChat(body); adaptErr == nil {
			var chat map[string]any
			_ = json.Unmarshal(adapted.Body, &chat)
			roles := []string{}
			for _, raw := range chat["messages"].([]any) {
				role, _ := raw.(map[string]any)["role"].(string)
				roles = append(roles, role)
			}
			toolNames := []string{}
			for _, raw := range chat["tools"].([]any) {
				fn, _ := raw.(map[string]any)["function"].(map[string]any)
				name, _ := fn["name"].(string)
				toolNames = append(toolNames, name)
			}
			requestShape.Store(fmt.Sprintf("responses_bytes=%d chat_bytes=%d roles=%v max=%v tools=%v", len(body), len(adapted.Body), roles, chat["max_completion_tokens"], toolNames))
		}
		calls.Add(1)
		s.handleResponses(w, r)
	}))
	defer local.Close()
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "value.txt"), []byte("old\n"), 0600); err != nil {
		t.Fatal(err)
	}
	cachePath := filepath.Join(os.Getenv("HOME"), ".codex", "models_cache.json")
	cacheBytes, err := os.ReadFile(cachePath)
	if err != nil {
		t.Fatal(err)
	}
	var cache map[string]any
	if err := json.Unmarshal(cacheBytes, &cache); err != nil {
		t.Fatal(err)
	}
	models, _ := cache["models"].([]any)
	if len(models) == 0 {
		t.Fatal("official Codex model cache is empty")
	}
	modelEntry := models[0].(map[string]any)
	modelEntry["slug"] = "regolo-live"
	modelEntry["display_name"] = "Regolo live acceptance"
	modelEntry["supports_search_tool"] = false
	modelEntry["base_instructions"] = "You are a coding agent. Follow the user request and use the available workspace tools."
	modelEntry["model_messages"] = map[string]any{"instructions_template": "You are a coding agent. Follow the user request and use the available workspace tools."}
	cache["models"] = []any{modelEntry}
	liveCatalog := filepath.Join(dir, "models.json")
	encodedCatalog, _ := json.Marshal(cache)
	if err := os.WriteFile(liveCatalog, encodedCatalog, 0600); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 240*time.Second)
	defer cancel()
	provider := fmt.Sprintf(`model_providers.brick={name="Brick Regolo live test",base_url=%q,wire_api="responses",requires_openai_auth=true,supports_websockets=false,http_headers={"X-Brick-Key"="local-regolo-live"},request_max_retries=0,stream_max_retries=0}`, local.URL+"/v1")
	prompt := "Call functions__exec exactly once with this exact JavaScript input, then report regolo-custom-tool-ok:\n" +
		`const result = await tools.apply_patch("*** Begin Patch\n*** Update File: value.txt\n@@\n-old\n+regolo-custom-tool-ok\n*** End Patch"); text(result);`
	cmd := exec.CommandContext(ctx, "codex", "exec", "--ignore-user-config", "--ephemeral", "--skip-git-repo-check", "--sandbox", "workspace-write", "-C", dir, "-m", "regolo-live", "-c", `model_provider="brick"`, "-c", `model_reasoning_effort="low"`, "-c", fmt.Sprintf("model_catalog_json=%q", liveCatalog), "-c", provider, prompt)
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("official Codex through Regolo failed: %v shape=%v\n%s", err, requestShape.Load(), out)
	}
	content, err := os.ReadFile(filepath.Join(dir, "value.txt"))
	if err != nil || string(content) != "regolo-custom-tool-ok\n" {
		t.Fatalf("custom tool did not edit workspace: %v %q\n%s", err, content, out)
	}
	if calls.Load() < 2 || customDeclarations.Load() == 0 {
		t.Fatalf("missing official custom-tool cycle: calls=%d custom declarations=%d", calls.Load(), customDeclarations.Load())
	}
	t.Logf("official Codex custom-tool cycle through Regolo passed: inference=%d", calls.Load())
}

func TestCodexOfficialMixedProviderContinuation(t *testing.T) {
	if os.Getenv("BRICK_MIXED_LIVE_TEST") != "1" {
		t.Skip("set BRICK_MIXED_LIVE_TEST=1 with BRICK_TEST_EXTERNAL for the mixed-provider acceptance test")
	}
	t.Setenv("BRICK_TEST_LOCAL", "local-mixed-live")
	cfg := &config.RouterConfig{CodexRouter: config.CodexRouterConfig{Enabled: true, LocalKeyEnv: "BRICK_TEST_LOCAL", TimeoutSeconds: 240}}
	cfg.ModelConfig = map[string]config.ModelParams{
		"terra-live":  {PreferredEndpoints: []string{"codex"}, UpstreamModel: "gpt-5.6-terra", ContextWindowSize: 272000},
		"regolo-live": {PreferredEndpoints: []string{"regolo"}, UpstreamModel: "gpt-oss-120b", ContextWindowSize: 128000},
	}
	cfg.ProviderEndpoints = []config.ProviderEndpoint{{Name: "codex", ProviderProfileName: "openai-codex"}, {Name: "regolo", ProviderProfileName: "regolo"}}
	cfg.ProviderProfiles = map[string]config.ProviderProfile{
		"openai-codex": {BaseURL: "https://chatgpt.com/backend-api/codex", Protocol: "responses", AuthSource: "codex_request", ResponsesPath: "responses", Capabilities: []string{"function_tools", "custom_tools", "opaque_reasoning", "images", "audio", "files", "item:additional_tools", "item:namespace"}},
		"regolo":       {BaseURL: "https://api.regolo.ai/v1", Protocol: "chat_completions", AuthSource: "provider_env", APIKeyEnv: "BRICK_TEST_EXTERNAL", Capabilities: []string{"function_tools"}},
	}
	cfg.SkillRouter.Models = []config.SkillRouterModelConfig{{Model: "terra-live"}, {Model: "regolo-live"}}
	s := &Server{cfg: cfg, brickRouter: mixedLiveRouter{}}
	s.brickRouterOnce.Do(func() {})
	var mu sync.Mutex
	selected := []string{}
	cachedUsageEvents := 0
	local := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requestBody, _ := io.ReadAll(r.Body)
		r.Body = io.NopCloser(bytes.NewReader(requestBody))
		predicted, _ := (mixedLiveRouter{}).RouteWithCandidates(r.Context(), codextransport.RoutingText(requestBody, 0), map[string]bool{"terra-live": true, "regolo-live": true})
		mu.Lock()
		if predicted != nil {
			selected = append(selected, predicted.Model)
		}
		mu.Unlock()
		capture := &captureResponseWriter{ResponseWriter: w}
		s.handleResponses(capture, r)
		mu.Lock()
		if bytes.Contains(capture.body.Bytes(), []byte(`"cached_tokens"`)) {
			cachedUsageEvents++
		}
		mu.Unlock()
	}))
	defer local.Close()
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "mixed.txt"), []byte("old\n"), 0600); err != nil {
		t.Fatal(err)
	}
	cacheBytes, err := os.ReadFile(filepath.Join(os.Getenv("HOME"), ".codex", "models_cache.json"))
	if err != nil {
		t.Fatal(err)
	}
	var cache map[string]any
	if json.Unmarshal(cacheBytes, &cache) != nil {
		t.Fatal("invalid Codex model cache")
	}
	entry := cache["models"].([]any)[0].(map[string]any)
	entry["slug"] = "brick"
	entry["display_name"] = "Brick mixed live"
	entry["supports_search_tool"] = false
	entry["context_window"] = 262000
	entry["max_context_window"] = 262000
	entry["base_instructions"] = "You are a coding agent. Follow each request concisely and use the named tool when asked."
	entry["model_messages"] = map[string]any{"instructions_template": entry["base_instructions"]}
	cache["models"] = []any{entry}
	catalog := filepath.Join(dir, "models.json")
	encoded, _ := json.Marshal(cache)
	if os.WriteFile(catalog, encoded, 0600) != nil {
		t.Fatal("cannot write test catalog")
	}
	provider := fmt.Sprintf(`model_providers.brick={name="Brick mixed live",base_url=%q,wire_api="responses",requires_openai_auth=true,supports_websockets=false,http_headers={"X-Brick-Key"="local-mixed-live"},request_max_retries=0,stream_max_retries=0}`, local.URL+"/v1")
	script := `import subprocess,json,sys,tempfile
url,catalog,provider,cwd=sys.argv[1:]
p=subprocess.Popen(['codex','app-server','-c','model="brick"','-c','model_provider="brick"','-c','model_reasoning_effort="low"','-c','model_catalog_json='+json.dumps(catalog),'-c',provider],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,text=True)
def send(i,m,params):p.stdin.write(json.dumps({'id':i,'method':m,'params':params})+'\n');p.stdin.flush()
def wait_id(i):
 for line in p.stdout:
  v=json.loads(line)
  if v.get('id')==i:
   if 'error' in v:raise RuntimeError(v['error'])
   return v['result']
 raise RuntimeError('app-server exited')
def done():
 text=''
 for line in p.stdout:
  v=json.loads(line)
  if v.get('method')=='item/agentMessage/delta':text+=v['params']['delta']
  if v.get('method')=='turn/completed':
   if v['params']['turn'].get('error'):raise RuntimeError(v['params']['turn']['error'])
   return text
 raise RuntimeError('app-server exited')
try:
 send(1,'initialize',{'clientInfo':{'name':'brick-mixed-live','version':'1'},'capabilities':{'experimentalApi':True}});wait_id(1)
 send(2,'thread/start',{'model':'brick','modelProvider':'brick','cwd':cwd,'ephemeral':True,'approvalPolicy':'never','sandbox':'workspace-write','baseInstructions':'Follow each request concisely.'});thread=wait_id(2)['thread']['id']
 send(3,'turn/start',{'threadId':thread,'input':[{'type':'text','text':'terra-first: reply ACK only.'}],'effort':'low'});wait_id(3);done()
 code='const result = await tools.apply_patch("*** Begin Patch\\n*** Update File: mixed.txt\\n@@\\n-old\\n+mixed-provider-ok\\n*** End Patch"); text(result);'
 send(4,'turn/start',{'threadId':thread,'input':[{'type':'text','text':'regolo-second: Call functions__exec exactly once with this exact JavaScript input, then report mixed-provider-ok:\n'+code}],'effort':'low'});wait_id(4);done()
 send(5,'turn/start',{'threadId':thread,'input':[{'type':'text','text':'terra-final: reply DONE only.'}],'effort':'low'});wait_id(5);done()
finally:
 p.terminate();p.wait(timeout=10)
`
	ctx, cancel := context.WithTimeout(context.Background(), 360*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "python3", "-c", script, local.URL, catalog, provider, dir)
	if output, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("mixed provider session failed: %v\n%s", err, output)
	}
	content, _ := os.ReadFile(filepath.Join(dir, "mixed.txt"))
	if string(content) != "mixed-provider-ok\n" {
		t.Fatalf("Regolo tool turn did not update workspace: %q", content)
	}
	mu.Lock()
	defer mu.Unlock()
	if len(selected) < 4 || selected[0] != "terra-live" || selected[len(selected)-1] != "terra-live" || !slices.Contains(selected, "regolo-live") {
		t.Fatalf("unexpected provider sequence: %v", selected)
	}
	if cachedUsageEvents == 0 {
		t.Fatal("no provider reported cached-token usage")
	}
	t.Logf("provider sequence=%v cached-usage-events=%d", selected, cachedUsageEvents)
}

func TestCodexOfficialLiveCompaction(t *testing.T) {
	if os.Getenv("BRICK_CODEX_COMPACT_TEST") != "1" {
		t.Skip("set BRICK_CODEX_COMPACT_TEST=1 for explicit live compaction")
	}
	t.Setenv("BRICK_TEST_LOCAL", "local-live")
	cfg := codexTestConfig("")
	cfg.ModelConfig = map[string]config.ModelParams{"gpt-5.6-terra": {PreferredEndpoints: []string{"codex"}}}
	cfg.ProviderEndpoints = []config.ProviderEndpoint{{Name: "codex", ProviderProfileName: "openai-codex"}}
	cfg.ProviderProfiles = map[string]config.ProviderProfile{"openai-codex": {BaseURL: "https://chatgpt.com/backend-api/codex", Protocol: "responses", AuthSource: "codex_request", CompactPath: "responses/compact", Capabilities: []string{"function_tools", "custom_tools", "opaque_reasoning", "compaction", "multimodal", "item:tool_search", "item:web_search", "item:additional_tools", "item:namespace"}}}
	s := &Server{cfg: cfg}
	var inference atomic.Int32
	var compact atomic.Int32
	local := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		inference.Add(1)
		if strings.HasSuffix(r.URL.Path, "/compact") {
			compact.Add(1)
		}
		s.handleResponses(w, r)
	}))
	defer local.Close()
	// This app-server is the test's original Codex session, outside inference.
	script := `import subprocess,json,sys,tempfile
url=sys.argv[1]
with tempfile.TemporaryDirectory(prefix='brick-compact-') as cwd:
 p=subprocess.Popen(['codex','app-server','-c','model_provider="brick"','-c','model="gpt-5.6-terra"','-c','model_reasoning_effort="medium"','-c','model_providers.brick='+json.dumps({'name':'Brick compaction test','base_url':url+'/v1','wire_api':'responses','requires_openai_auth':True,'supports_websockets':False,'http_headers':{'X-Brick-Key':'local-live'},'request_max_retries':0,'stream_max_retries':0}).replace(': ', ' = ').replace('"name"','name').replace('"base_url"','base_url').replace('"wire_api"','wire_api').replace('"requires_openai_auth"','requires_openai_auth').replace('"supports_websockets"','supports_websockets').replace('"http_headers"','http_headers').replace('"request_max_retries"','request_max_retries').replace('"stream_max_retries"','stream_max_retries')],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,text=True)
 def send(id,method,params):
  p.stdin.write(json.dumps({'id':id,'method':method,'params':params})+'\n');p.stdin.flush()
 def wait_id(id):
  for line in p.stdout:
   v=json.loads(line)
   if v.get('id')==id:
    if 'error' in v: raise RuntimeError(v['error'])
    return v['result']
  raise RuntimeError('app-server exited')
 def completed():
  text=''
  for line in p.stdout:
   v=json.loads(line)
   if v.get('method')=='item/agentMessage/delta':text+=v['params']['delta']
   if v.get('method')=='turn/completed':
    if v['params']['turn'].get('error'):raise RuntimeError(v['params']['turn']['error'])
    return text
  raise RuntimeError('app-server exited')
 try:
  send(1,'initialize',{'clientInfo':{'name':'brick-protocol-test','version':'1'},'capabilities':{'experimentalApi':True}});wait_id(1)
  send(2,'thread/start',{'model':'gpt-5.6-terra','modelProvider':'brick','cwd':cwd,'ephemeral':True,'approvalPolicy':'never','sandbox':'read-only','baseInstructions':'Answer the user briefly. Do not use tools.'});thread=wait_id(2)['thread']['id']
  send(3,'turn/start',{'threadId':thread,'input':[{'type':'text','text':'Remember the test marker brick-compaction-42. Reply acknowledged.'}],'effort':'medium'});wait_id(3);completed()
  send(4,'thread/compact/start',{'threadId':thread});wait_id(4);completed()
  send(5,'turn/start',{'threadId':thread,'input':[{'type':'text','text':'Return the exact test marker from earlier, without tools.'}],'effort':'medium'});wait_id(5);answer=completed()
  if 'brick-compaction-42' not in answer:raise RuntimeError('context was not retained after compaction')
  print('official compaction completed; subsequent turn retained context')
 finally:
  p.terminate();p.wait(timeout=10)
`
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "python3", "-c", script, local.URL)
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("compaction failed: %v %s", err, out)
	}
	if inference.Load() < 3 {
		t.Fatalf("compaction did not perform inference: calls=%d %s", inference.Load(), out)
	}
	t.Logf("official compaction and post-compaction context passed: inference=%d, dedicated compact endpoint=%d", inference.Load(), compact.Load())
}
