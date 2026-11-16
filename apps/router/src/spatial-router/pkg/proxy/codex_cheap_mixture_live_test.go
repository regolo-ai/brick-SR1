package proxy

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/regolo-ai/brick-SR1/apps/router/src/spatial-router/pkg/brickrouting"
	"github.com/regolo-ai/brick-SR1/apps/router/src/spatial-router/pkg/config"
)

// cheapMixObservation is one request observed by the local Brick endpoint.
type cheapMixObservation struct {
	Model              string
	ReasoningRequested string
	ReasoningSent      string
	Status             int
}

// TestCodexCheapMixtureRoutingLive exercises the real Codex app-server against
// the real SystemOne router with a cheap mixture: gpt-5.6-luna for creative
// requests and gpt-5.6-terra for coding/agentic requests, both at the maximum
// reasoning level the Codex catalog advertises (xhigh).
//
// The keyword rules make the expected route deterministic while still going
// through the production router; the skill vectors remain as the fallback.
//
// Opt in with BRICK_CODEX_CHEAP_MIX_LIVE_TEST=1 (uses the ChatGPT subscription
// credentials already present in ~/.codex/auth.json).
func TestCodexCheapMixtureRoutingLive(t *testing.T) {
	if os.Getenv("BRICK_CODEX_CHEAP_MIX_LIVE_TEST") != "1" {
		t.Skip("set BRICK_CODEX_CHEAP_MIX_LIVE_TEST=1 for the luna/terra cheap-mixture live test")
	}
	t.Setenv("BRICK_TEST_LOCAL", "local-cheap-mix")

	checkpoint, err := filepath.Abs("../../models/modernbert-capability-classifier")
	if err != nil {
		t.Fatal(err)
	}
	useReasoning := true
	cfg := &config.RouterConfig{CodexRouter: config.CodexRouterConfig{Enabled: true, LocalKeyEnv: "BRICK_TEST_LOCAL", TimeoutSeconds: 300}}
	cfg.ModelConfig = map[string]config.ModelParams{
		// The Codex catalog tops out at xhigh; declaring the ladder makes a
		// client that asks for "max" clamp down instead of leaking an
		// unsupported level upstream.
		"luna-live":  {PreferredEndpoints: []string{"codex"}, UpstreamModel: "gpt-5.6-luna", ContextWindowSize: 272000, AllowedThinkingModes: []string{"low", "medium", "high", "xhigh"}},
		"terra-live": {PreferredEndpoints: []string{"codex"}, UpstreamModel: "gpt-5.6-terra", ContextWindowSize: 272000, AllowedThinkingModes: []string{"low", "medium", "high", "xhigh"}},
	}
	cfg.ProviderEndpoints = []config.ProviderEndpoint{{Name: "codex", ProviderProfileName: "openai-codex"}}
	cfg.ProviderProfiles = map[string]config.ProviderProfile{
		"openai-codex": {BaseURL: "https://chatgpt.com/backend-api/codex", Protocol: "responses", AuthSource: "codex_request", ResponsesPath: "responses", Capabilities: []string{"function_tools", "custom_tools", "opaque_reasoning", "images", "audio", "files", "item:additional_tools", "item:namespace"}},
	}
	cfg.SkillRouter = config.SkillRouterConfig{
		Enabled:      true,
		Capabilities: []string{"instruction_following", "coding", "math_reasoning", "world_knowledge", "planning_agentic", "creative_synthesis"},
		Models: []config.SkillRouterModelConfig{
			// Same vectors the CLI starter pool writes, in the router's
			// canonical capability order.
			{Model: "luna-live", SkillVector: []float64{0.25, 0.56, 0.67, 0.57, 0.57, 0.57}, ModelReasoningControl: config.ModelReasoningControl{UseReasoning: &useReasoning}},
			{Model: "terra-live", SkillVector: []float64{0.80, 0.85, 0.88, 0.88, 0.86, 0.85}, ModelReasoningControl: config.ModelReasoningControl{UseReasoning: &useReasoning}},
		},
		ActiveModels: []string{"luna-live", "terra-live"},
		Keywords: []config.SkillRouterKeywordRuleConfig{
			{Name: "cheap-luna", Model: "luna-live", Keywords: []string{"poem", "haiku", "limerick"}},
			{Name: "strong-terra", Model: "terra-live", Keywords: []string{"apply_patch", "refactor", "bug"}},
		},
		SystemOne: config.SystemOneConfig{LocalPath: checkpoint},
	}

	router, err := brickrouting.New(cfg)
	if err != nil {
		t.Fatalf("initialize SystemOne router: %v", err)
	}
	t.Cleanup(func() {
		if closer, ok := any(router).(interface{ Close() }); ok {
			closer.Close()
		}
	})
	s := &Server{cfg: cfg, brickRouter: router}

	var mu sync.Mutex
	observations := []cheapMixObservation{}
	local := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requestBody, _ := io.ReadAll(r.Body)
		r.Body = io.NopCloser(bytes.NewReader(requestBody))
		capture := &cheapMixCaptureWriter{ResponseWriter: w}
		s.handleResponses(capture, r)
		mu.Lock()
		observations = append(observations, cheapMixObservation{
			Model:              capture.Header().Get("X-Brick-Selected-Model"),
			ReasoningRequested: capture.Header().Get("X-Brick-Reasoning-Requested"),
			ReasoningSent:      capture.Header().Get("X-Brick-Reasoning-Sent"),
			Status:             capture.status,
		})
		mu.Unlock()
	}))
	defer local.Close()

	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "mixed.txt"), []byte("old\n"), 0600); err != nil {
		t.Fatal(err)
	}
	catalog := writeCheapMixCatalog(t, dir)

	provider := fmt.Sprintf(`model_providers.brick={name="Brick cheap mix",base_url=%q,wire_api="responses",requires_openai_auth=true,supports_websockets=false,http_headers={"X-Brick-Key"="local-cheap-mix"},request_max_retries=0,stream_max_retries=0}`, local.URL+"/v1")
	script := `import subprocess,json,sys
url,catalog,provider,cwd=sys.argv[1:]
p=subprocess.Popen(['codex','app-server','-c','model="brick"','-c','model_provider="brick"','-c','model_reasoning_effort="xhigh"','-c','model_catalog_json='+json.dumps(catalog),'-c',provider],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,text=True)
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
 send(1,'initialize',{'clientInfo':{'name':'brick-cheap-mix','version':'1'},'capabilities':{'experimentalApi':True}});wait_id(1)
 send(2,'thread/start',{'model':'brick','modelProvider':'brick','cwd':cwd,'ephemeral':True,'approvalPolicy':'never','sandbox':'workspace-write','baseInstructions':'Follow each request concisely.'});thread=wait_id(2)['thread']['id']
 send(3,'turn/start',{'threadId':thread,'input':[{'type':'text','text':'luna-poem: reply with a two-line poem about the sea. Do not use tools.'}],'effort':'xhigh'});wait_id(3);done()
 code='const result = await tools.apply_patch("*** Begin Patch\\n*** Update File: mixed.txt\\n@@\\n-old\\n+cheap-mix-ok\\n*** End Patch"); text(result);'
 send(4,'turn/start',{'threadId':thread,'input':[{'type':'text','text':'terra-patch: Call functions__exec exactly once with this exact JavaScript input, then report cheap-mix-ok:\n'+code}],'effort':'xhigh'});wait_id(4);done()
 send(5,'turn/start',{'threadId':thread,'input':[{'type':'text','text':'luna-poem-final: reply DONE only.'}],'effort':'xhigh'});wait_id(5);done()
finally:
 p.terminate();p.wait(timeout=10)
`
	ctx, cancel := context.WithTimeout(context.Background(), 480*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "python3", "-c", script, local.URL, catalog, provider, dir)
	if output, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("cheap-mixture Codex session failed: %v\n%s", err, output)
	}

	content, _ := os.ReadFile(filepath.Join(dir, "mixed.txt"))
	if string(content) != "cheap-mix-ok\n" {
		t.Fatalf("terra tool turn did not update workspace: %q", content)
	}

	mu.Lock()
	routed := append([]cheapMixObservation(nil), observations...)
	mu.Unlock()
	if len(routed) < 3 {
		t.Fatalf("expected at least three routed requests, got %d: %+v", len(routed), routed)
	}
	if routed[0].Model != "luna-live" {
		t.Fatalf("first request routed to %q, want luna-live: %+v", routed[0].Model, routed)
	}
	if routed[len(routed)-1].Model != "luna-live" {
		t.Fatalf("last request routed to %q, want luna-live: %+v", routed[len(routed)-1].Model, routed)
	}
	sawLuna, sawTerra := false, false
	for _, obs := range routed {
		if obs.Status != http.StatusOK {
			t.Fatalf("routed request returned %d: %+v", obs.Status, routed)
		}
		switch obs.Model {
		case "luna-live":
			sawLuna = true
		case "terra-live":
			sawTerra = true
		default:
			t.Fatalf("unexpected routed model %q: %+v", obs.Model, routed)
		}
		if obs.ReasoningSent != "xhigh" {
			t.Fatalf("request sent effort %q, want xhigh: %+v", obs.ReasoningSent, routed)
		}
	}
	if !sawLuna || !sawTerra {
		t.Fatalf("mixture did not touch both cheap models (luna=%v terra=%v): %+v", sawLuna, sawTerra, routed)
	}
	t.Logf("cheap mixture routed: %+v", routed)

	// The same pool without the keyword override must still escalate from the
	// cheap tier to the strong tier as the effort knob rises.
	noKeywords := ""
	for _, classifierCase := range []struct {
		prompt string
		knob   float64
		want   string
	}{
		{prompt: "write a two-line poem about the sea", knob: 0, want: "luna-live"},
		{prompt: "fix the off-by-one bug in this Go function and run the tests", knob: 0.5, want: "luna-live"},
		{prompt: "fix the off-by-one bug in this Go function and run the tests", knob: 1, want: "terra-live"},
	} {
		knob := classifierCase.knob
		result, routeErr := router.RouteWithOptions(context.Background(), classifierCase.prompt, brickrouting.RoutingOptions{
			Candidates:  map[string]bool{"luna-live": true, "terra-live": true},
			Knob:        &knob,
			KeywordText: &noKeywords,
		})
		if routeErr != nil {
			t.Fatalf("classifier route for %q: %v", classifierCase.prompt, routeErr)
		}
		if result.Model != classifierCase.want {
			t.Fatalf("classifier routed %q at knob %.1f to %q, want %q", classifierCase.prompt, knob, result.Model, classifierCase.want)
		}
	}
	t.Log("classifier escalation luna -> terra at max effort verified")

	// Direct probe: an explicit "max" must clamp to xhigh for a Codex model
	// whose catalog tops out at xhigh, and must never reach the backend as max.
	token, err := codexAccessToken()
	if err != nil {
		t.Fatalf("read Codex access token: %v", err)
	}
	probeBody := `{"model":"brick","input":[{"role":"user","content":"apply_patch bug probe: reply OK only."}],"reasoning":{"effort":"max"},"stream":true}`
	req, _ := http.NewRequest("POST", local.URL+"/v1/responses", strings.NewReader(probeBody))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Brick-Key", "local-cheap-mix")
	req.Header.Set("Authorization", "Bearer "+token)
	probeClient := &http.Client{Timeout: 240 * time.Second}
	resp, err := probeClient.Do(req)
	if err != nil {
		t.Fatalf("max-effort probe failed: %v", err)
	}
	defer resp.Body.Close()
	probeOut, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("max-effort probe returned %d: %s", resp.StatusCode, probeOut)
	}
	if got := resp.Header.Get("X-Brick-Selected-Model"); got != "terra-live" {
		t.Fatalf("max-effort probe routed to %q, want terra-live", got)
	}
	if got := resp.Header.Get("X-Brick-Reasoning-Requested"); got != "max" {
		t.Fatalf("max-effort probe request effort = %q, want max", got)
	}
	if got := resp.Header.Get("X-Brick-Reasoning-Sent"); got != "xhigh" {
		t.Fatalf("max-effort probe sent effort = %q, want clamped xhigh", got)
	}
	t.Log("max effort clamped to xhigh and served by terra-live")
}

// cheapMixCaptureWriter keeps the streaming behaviour and records the final
// status so the handler can report per-request evidence.
type cheapMixCaptureWriter struct {
	http.ResponseWriter
	status int
}

func (w *cheapMixCaptureWriter) WriteHeader(code int) {
	w.status = code
	w.ResponseWriter.WriteHeader(code)
}

func (w *cheapMixCaptureWriter) Write(p []byte) (int, error) {
	if w.status == 0 {
		w.status = http.StatusOK
	}
	return w.ResponseWriter.Write(p)
}

func (w *cheapMixCaptureWriter) Flush() {
	if f, ok := w.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

// writeCheapMixCatalog rewrites one cached Codex model entry into a virtual
// "brick" model so the official client accepts the router as its provider.
func writeCheapMixCatalog(t *testing.T, dir string) string {
	t.Helper()
	home, err := os.UserHomeDir()
	if err != nil {
		t.Fatal(err)
	}
	cacheBytes, err := os.ReadFile(filepath.Join(home, ".codex", "models_cache.json"))
	if err != nil {
		t.Fatal(err)
	}
	var cache map[string]any
	if err := json.Unmarshal(cacheBytes, &cache); err != nil {
		t.Fatal("invalid Codex model cache")
	}
	models, ok := cache["models"].([]any)
	if !ok || len(models) == 0 {
		t.Fatal("Codex model cache has no models")
	}
	entry := models[0].(map[string]any)
	entry["slug"] = "brick"
	entry["display_name"] = "Brick cheap mix"
	entry["supports_search_tool"] = false
	entry["context_window"] = 262000
	entry["max_context_window"] = 262000
	entry["base_instructions"] = "You are a coding agent. Follow each request concisely and use the named tool when asked."
	entry["model_messages"] = map[string]any{"instructions_template": entry["base_instructions"]}
	cache["models"] = []any{entry}
	encoded, err := json.Marshal(cache)
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "models.json")
	if err := os.WriteFile(path, encoded, 0600); err != nil {
		t.Fatal(err)
	}
	return path
}

// codexAccessToken returns the ChatGPT access token the official client would
// send, so the direct probe exercises the same proxy authentication path.
func codexAccessToken() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	raw, err := os.ReadFile(filepath.Join(home, ".codex", "auth.json"))
	if err != nil {
		return "", err
	}
	var auth struct {
		Tokens struct {
			AccessToken string `json:"access_token"`
		} `json:"tokens"`
	}
	if err := json.Unmarshal(raw, &auth); err != nil {
		return "", err
	}
	if strings.TrimSpace(auth.Tokens.AccessToken) == "" {
		return "", fmt.Errorf("empty access_token")
	}
	return auth.Tokens.AccessToken, nil
}
