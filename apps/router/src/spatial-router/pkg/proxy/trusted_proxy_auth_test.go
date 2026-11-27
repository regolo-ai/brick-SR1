package proxy

import (
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/regolo-ai/brick-SR1/apps/router/src/spatial-router/pkg/config"
)

func TestTrustedProxyCredentialResolution(t *testing.T) {
	s := &Server{cfg: &config.RouterConfig{TrustedProxyHeader: "X-Regolo-User-Key"}}
	for _, tc := range []struct {
		name, authorization, trusted, want string
		wantErr                            bool
	}{
		{name: "direct", authorization: "Bearer direct-key", want: "direct-key"},
		{name: "proxy", trusted: "proxy-key", want: "proxy-key"},
		{name: "matching", authorization: "Bearer same-key", trusted: "same-key", want: "same-key"},
		{name: "conflict", authorization: "Bearer direct-key", trusted: "proxy-key", wantErr: true},
		{name: "invalid trusted", authorization: "Bearer direct-key", trusted: "${REGOLO_API_KEY}", wantErr: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", nil)
			req.Header.Set("Authorization", tc.authorization)
			req.Header.Set("X-Regolo-User-Key", tc.trusted)
			got, err := s.resolveClientAPIKey(req)
			if (err != nil) != tc.wantErr || got != tc.want {
				t.Fatalf("credential=%q error=%v, want credential=%q error=%v", got, err, tc.want, tc.wantErr)
			}
		})
	}
}

func TestTrustedProxyCredentialsStayRequestScoped(t *testing.T) {
	var mu sync.Mutex
	seen := make(map[string]string)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-Regolo-User-Key") != "" {
			t.Error("trusted proxy header leaked to the model upstream")
		}
		mu.Lock()
		seen[r.Header.Get("User-Agent")] = r.Header.Get("Authorization")
		mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{"choices":[{"message":{"content":"OK"},"finish_reason":"stop"}]}`)
	}))
	defer upstream.Close()

	cfg := &config.RouterConfig{TrustedProxyHeader: "X-Regolo-User-Key"}
	cfg.Brick.Enabled = true
	cfg.AutoModelName = "brick-v1-beta"
	cfg.BackendModels.ModelConfig = map[string]config.ModelParams{
		"model": {UseClientKey: true, PreferredEndpoints: []string{"test"}},
	}
	cfg.BackendModels.ProviderProfiles = map[string]config.ProviderProfile{
		"test": {Type: "openai_compatible", BaseURL: upstream.URL},
	}
	cfg.BackendModels.ProviderEndpoints = []config.ProviderEndpoint{{Name: "test", ProviderProfileName: "test"}}
	s := &Server{cfg: cfg}

	var wg sync.WaitGroup
	for _, key := range []string{"user-a-key", "user-b-key"} {
		key := key
		wg.Add(1)
		go func() {
			defer wg.Done()
			req := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", strings.NewReader(`{"model":"brick-v1-beta","messages":[{"role":"user","content":"hello"}]}`))
			req.Header.Set("X-Regolo-User-Key", key)
			req.Header.Set("User-Agent", key)
			req.Header.Set("x-selected-model", "model")
			rec := httptest.NewRecorder()
			s.handleChatCompletions(rec, req)
			if rec.Code != http.StatusOK {
				data, _ := io.ReadAll(rec.Result().Body)
				t.Errorf("%s: status=%d body=%s", key, rec.Code, data)
			}
		}()
	}
	wg.Wait()

	mu.Lock()
	defer mu.Unlock()
	for _, key := range []string{"user-a-key", "user-b-key"} {
		if seen[key] != "Bearer "+key {
			t.Errorf("%s forwarded with %q", key, seen[key])
		}
	}
}

func TestConflictingCredentialsAreRejectedBeforeForwarding(t *testing.T) {
	cfg := &config.RouterConfig{TrustedProxyHeader: "X-Regolo-User-Key"}
	cfg.Brick.Enabled = true
	cfg.AutoModelName = "brick-v1-beta"
	cfg.BackendModels.ModelConfig = map[string]config.ModelParams{"model": {}}
	req := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", strings.NewReader(`{"model":"brick-v1-beta","messages":[{"role":"user","content":"hello"}]}`))
	req.Header.Set("Authorization", "Bearer direct-key")
	req.Header.Set("X-Regolo-User-Key", "proxy-key")
	req.Header.Set("x-selected-model", "model")
	rec := httptest.NewRecorder()
	(&Server{cfg: cfg}).handleChatCompletions(rec, req)
	if rec.Code != http.StatusUnauthorized || strings.Contains(rec.Body.String(), "direct-key") || strings.Contains(rec.Body.String(), "proxy-key") {
		t.Fatalf("unexpected response: status=%d body=%s", rec.Code, rec.Body.String())
	}
}
