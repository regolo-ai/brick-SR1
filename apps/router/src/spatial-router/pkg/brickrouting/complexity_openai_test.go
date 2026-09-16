package brickrouting

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus/testutil"
	"github.com/regolo-ai/brick-SR1/apps/router/src/spatial-router/pkg/config"
	"github.com/regolo-ai/brick-SR1/apps/router/src/spatial-router/pkg/observability/metrics"
)

// newTestOpenAIClient builds a complexityClient in openai mode pointed at url.
func newTestOpenAIClient(url string) *complexityClient {
	return &complexityClient{
		baseURL:           url,
		protocol:          "openai",
		modelName:         "brick-complexity",
		defaultConfidence: 0.5,
		httpClient:        &http.Client{Timeout: 3 * time.Second},
	}
}

func TestClassifyOpenAI_LabelAndLogprobConfidence(t *testing.T) {
	// Logprobs for the three labels; chosen token is "hard".
	lpEasy, lpMedium, lpHard := -3.2, -1.1, -0.15
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/chat/completions" {
			t.Errorf("unexpected path %s", r.URL.Path)
		}
		var request map[string]any
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			t.Error(err)
		}
		for _, field := range []string{"max_tokens", "max_completion_tokens", "max_output_tokens"} {
			if _, exists := request[field]; exists {
				t.Errorf("classifier must not inject %s", field)
			}
		}
		resp := map[string]any{
			"choices": []map[string]any{{
				"message": map[string]any{"content": "hard"},
				"logprobs": map[string]any{
					"content": []map[string]any{{
						"token":   "hard",
						"logprob": lpHard,
						"top_logprobs": []map[string]any{
							{"token": "hard", "logprob": lpHard},
							{"token": "medium", "logprob": lpMedium},
							{"token": "easy", "logprob": lpEasy},
						},
					}},
				},
			}},
		}
		_ = json.NewEncoder(w).Encode(resp)
	}))
	defer srv.Close()

	label, conf := newTestOpenAIClient(srv.URL).Classify(context.Background(), "prove linearizability of Raft")
	if label != "hard" {
		t.Fatalf("label = %q, want hard", label)
	}
	sum := math.Exp(lpEasy) + math.Exp(lpMedium) + math.Exp(lpHard)
	want := math.Exp(lpHard) / sum
	if math.Abs(conf-want) > 1e-6 {
		t.Fatalf("confidence = %v, want %v", conf, want)
	}
}

func TestClassifyOpenAI_NoLogprobsDefaultsConfidence(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		resp := map[string]any{
			"choices": []map[string]any{{
				"message": map[string]any{"content": " Easy"},
			}},
		}
		_ = json.NewEncoder(w).Encode(resp)
	}))
	defer srv.Close()

	label, conf := newTestOpenAIClient(srv.URL).Classify(context.Background(), "what is 2+2")
	if label != "easy" {
		t.Fatalf("label = %q, want easy (normalized)", label)
	}
	// No logprobs: must use the client's default_confidence (0.5 here), NOT a
	// silent 1.0 that would overstate certainty and skip the shrink-to-medium.
	if conf != 0.5 {
		t.Fatalf("confidence = %v, want 0.5 (default_confidence fallback)", conf)
	}
}

func TestClassifyOpenAI_NoLogprobsRespectsCustomDefault(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		resp := map[string]any{
			"choices": []map[string]any{{
				"message": map[string]any{"content": "hard"},
			}},
		}
		_ = json.NewEncoder(w).Encode(resp)
	}))
	defer srv.Close()

	c := newTestOpenAIClient(srv.URL)
	c.defaultConfidence = 0.8
	label, conf := c.Classify(context.Background(), "prove the spectral theorem")
	if label != "hard" {
		t.Fatalf("label = %q, want hard", label)
	}
	if conf != 0.8 {
		t.Fatalf("confidence = %v, want 0.8 (custom default_confidence)", conf)
	}
}

func TestClassifyOpenAI_ServerErrorFallsBack(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "boom", http.StatusInternalServerError)
	}))
	defer srv.Close()

	label, conf := newTestOpenAIClient(srv.URL).Classify(context.Background(), "anything")
	if label != "medium" || conf != 1.0 {
		t.Fatalf("got (%q,%v), want (medium,1.0) fallback", label, conf)
	}
}

// TestStripProviderPrefix guards the defensive fallback that lets a stale
// profile (model_id="regolo/brick-complexity-pro", no model_name) still send a
// valid OpenAI model name to the hosted classifier.
func TestStripProviderPrefix(t *testing.T) {
	cases := map[string]string{
		"regolo/brick-complexity-pro": "brick-complexity-pro",
		"brick-complexity-pro":        "brick-complexity-pro", // no slash: unchanged
		"":                            "",
		"regolo/":                     "regolo/",  // empty tail: unchanged, not mangled
		"/leading":                    "/leading", // leading slash: unchanged
		"org/team/model":              "team/model",
	}
	for in, want := range cases {
		if got := stripProviderPrefix(in); got != want {
			t.Errorf("stripProviderPrefix(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestConfidenceFromLogprobs(t *testing.T) {
	alts := map[string]float64{"easy": -0.05, " medium": -2.0, "hard": -4.0}
	conf, ok := confidenceFromLogprobs("easy", alts)
	if !ok {
		t.Fatal("expected ok")
	}
	sum := math.Exp(-0.05) + math.Exp(-2.0) + math.Exp(-4.0)
	want := math.Exp(-0.05) / sum
	if math.Abs(conf-want) > 1e-9 {
		t.Fatalf("conf = %v, want %v", conf, want)
	}
	if _, ok := confidenceFromLogprobs("hard", map[string]float64{"easy": -0.1}); ok {
		t.Fatal("expected not-ok when chosen label absent")
	}
}

// TestNormalizeComplexityLabel_StrictNoFuzzyMatch guards the deliberate
// tightening from a substring/fuzzy match to an exact one. A misconfigured
// classifier (wrong model name routed to a generic chat model, as happened in
// production: the router sent "regolo/brick-complexity-pro" to an endpoint
// that only recognizes "brick-complexity-pro") tends to echo ordinary prose
// that happens to CONTAIN one of the three label words. The old fuzzy match
// would silently accept "This is not hard to do." as a confident "hard"
// verdict; the strict version must reject it and let the caller fall back.
func TestNormalizeComplexityLabel_StrictNoFuzzyMatch(t *testing.T) {
	cases := []struct {
		in     string
		want   string
		wantOK bool
	}{
		{"easy", "easy", true},
		{" Hard\n", "hard", true},
		{"MEDIUM", "medium", true},
		{"This is not hard to do.", "medium", false},
		{"Hello! How can I help you today?", "medium", false},
		{"", "medium", false},
	}
	for _, c := range cases {
		got, ok := normalizeComplexityLabel(c.in)
		if got != c.want || ok != c.wantOK {
			t.Errorf("normalizeComplexityLabel(%q) = (%q,%v), want (%q,%v)", c.in, got, ok, c.want, c.wantOK)
		}
	}
}

// TestClassifyOpenAI_UnrecognizedLabelFallsBackAndCountsMetric exercises the
// full classifyOpenAI path (not just the normalize helper) against a server
// that echoes ordinary chat prose instead of a label — reproducing the
// production incident where a chat model behind an unexpectedly-named
// endpoint answered "The answer to 2 + 2 is 4." instead of "easy". Must
// degrade to medium/1.0 (never fail the request) and must increment
// BrickCCClassifyFallback so the misconfiguration is visible in
// `brick claude status` / metrics instead of silently distorting routing.
func TestClassifyOpenAI_UnrecognizedLabelFallsBackAndCountsMetric(t *testing.T) {
	metrics.BrickCCClassifyFallback.Reset()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		resp := map[string]any{
			"choices": []map[string]any{{
				"message": map[string]any{"content": "The answer to 2 + 2 is 4."},
			}},
		}
		_ = json.NewEncoder(w).Encode(resp)
	}))
	defer srv.Close()

	label, conf := newTestOpenAIClient(srv.URL).Classify(context.Background(), "what is 2+2")
	if label != "medium" || conf != 1.0 {
		t.Fatalf("got (%q,%v), want (medium,1.0) fallback on unrecognized label", label, conf)
	}
	if got := testutil.ToFloat64(metrics.BrickCCClassifyFallback.WithLabelValues()); got != 1 {
		t.Fatalf("BrickCCClassifyFallback = %v, want 1", got)
	}
}

func TestComplexityCredentialResolutionFailsClosed(t *testing.T) {
	for _, source := range []string{"service", "skill"} {
		for _, value := range []string{"server-key", "", "${REGOLO_API_KEY}"} {
			t.Run(source+"/"+value, func(t *testing.T) {
				t.Setenv("REGOLO_API_KEY", value)
				var calls atomic.Int32
				upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					calls.Add(1)
					if r.Header.Get("Authorization") != "Bearer server-key" {
						t.Error("classifier received incorrect authorization")
					}
					fmt.Fprint(w, `{"choices":[{"message":{"content":"easy"}}]}`)
				}))
				defer upstream.Close()
				cfg := &config.RouterConfig{}
				cfg.ComplexityService = &config.ComplexityServiceConfig{
					BaseURL: upstream.URL, Protocol: "openai", BearerToken: "${REGOLO_API_KEY}",
				}
				if source == "skill" {
					cfg.SkillRouter.ComplexityModel.BearerToken = "${REGOLO_API_KEY}"
					// A broken explicit skill source must not fall back to this valid token.
					cfg.ComplexityService.BearerToken = "server-key"
				}
				c := newComplexityClient(cfg, cfg.SkillRouter.ComplexityModel)
				label, _ := c.Classify(context.Background(), "hello")
				if value == "server-key" {
					if calls.Load() != 1 || label != "easy" {
						t.Fatalf("expected authenticated classifier call, calls=%d label=%s", calls.Load(), label)
					}
				} else if calls.Load() != 0 || c.credentialErr == nil {
					t.Fatal("invalid classifier credential must prevent network requests")
				}
			})
		}
	}
}

func TestComplexityClientKeepsConcurrentUserKeysSeparate(t *testing.T) {
	t.Setenv("REGOLO_API_KEY", "server-key-must-not-be-used")
	var calls atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		var body struct {
			Messages []struct {
				Content string `json:"content"`
			} `json:"messages"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil || len(body.Messages) != 2 {
			t.Error("invalid classifier request")
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		userKey := strings.TrimPrefix(body.Messages[1].Content, "Classify: ")
		if got := r.Header.Get("Authorization"); got != "Bearer "+userKey {
			t.Error("classifier credential crossed request boundaries")
		}
		fmt.Fprint(w, `{"choices":[{"message":{"content":"easy"}}]}`)
	}))
	defer upstream.Close()
	for _, source := range []string{"service", "skill"} {
		cfg := &config.RouterConfig{}
		cfg.ComplexityService = &config.ComplexityServiceConfig{
			BaseURL: upstream.URL, Protocol: "openai", BearerToken: "${REGOLO_API_KEY}", UseClientKey: source == "service",
		}
		cfg.SkillRouter.ComplexityModel.UseClientKey = source == "skill"
		c := newComplexityClient(cfg, cfg.SkillRouter.ComplexityModel)
		var wg sync.WaitGroup
		for i := 0; i < 20; i++ {
			wg.Add(1)
			go func(i int) {
				defer wg.Done()
				key := fmt.Sprintf("user-%d-key", i)
				ctx := config.WithClientAPIKey(context.Background(), key)
				if label, _ := c.Classify(ctx, key); label != "easy" {
					t.Error("authenticated classifier call failed")
				}
			}(i)
		}
		wg.Wait()
		if c.bearerToken != "" {
			t.Fatal("shared classifier must not retain a user or server key")
		}
		before := calls.Load()
		for _, invalid := range []string{"", "  ", "${REGOLO_API_KEY}"} {
			c.Classify(config.WithClientAPIKey(context.Background(), invalid), "invalid")
		}
		if calls.Load() != before {
			t.Fatal("missing user credential must not fall back to the server token")
		}
	}
	if calls.Load() != 40 {
		t.Fatalf("expected 40 requests, got %d", calls.Load())
	}
}
