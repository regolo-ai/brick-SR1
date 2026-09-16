package proxy

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus/testutil"
	"github.com/regolo-ai/brick-SR1/apps/router/src/spatial-router/pkg/brickrouting"
	"github.com/regolo-ai/brick-SR1/apps/router/src/spatial-router/pkg/config"
	"github.com/regolo-ai/brick-SR1/apps/router/src/spatial-router/pkg/economics"
	"github.com/regolo-ai/brick-SR1/apps/router/src/spatial-router/pkg/headers"
	"github.com/regolo-ai/brick-SR1/apps/router/src/spatial-router/pkg/observability/metrics"
	candle "github.com/regolo-ai/brick-SR1/candle-binding"
)

type regoloTraceRouter struct {
	*brickrouting.Router
	key, text string
	result    *brickrouting.Result
}

func (r *regoloTraceRouter) RouteWithCandidates(ctx context.Context, text string, allow map[string]bool) (*brickrouting.Result, error) {
	if config.ClientAPIKey(ctx) != r.key || text != r.text || allow != nil {
		return nil, fmt.Errorf("routing context, text, or candidate scope changed")
	}
	result, err := r.Router.RouteWithCandidates(ctx, text, allow)
	r.result = result
	return result, err
}

// TestRegoloLiveTrace is opt-in: it performs billable requests using the supplied
// caller credential. Run from the router root with the capability weights in
// models/ and BRICK_REGOLO_LIVE_CONFIG pointing to the deployment YAML.
// Credentials are compared in memory and never included in test diagnostics.
func TestRegoloLiveTrace(t *testing.T) {
	key := os.Getenv("BRICK_REGOLO_LIVE_API_KEY")
	if key == "" {
		t.Skip("set BRICK_REGOLO_LIVE_API_KEY to run live Regolo inference")
	}
	path := os.Getenv("BRICK_REGOLO_LIVE_CONFIG")
	if path == "" {
		t.Fatal("BRICK_REGOLO_LIVE_CONFIG is required")
	}
	cfg, err := config.Parse(path)
	if err != nil {
		t.Fatal("cannot parse deployment configuration")
	}
	checkpoint, err := os.ReadFile(filepath.Join(cfg.SkillRouter.CapabilityModel.ModelID, "config.json"))
	if err != nil {
		t.Fatal("cannot read capability checkpoint metadata")
	}
	var metadata struct {
		Labels map[string]string `json:"id2label"`
	}
	if json.Unmarshal(checkpoint, &metadata) != nil {
		t.Fatal("invalid checkpoint metadata")
	}
	for i, label := range cfg.SkillRouter.CapabilityModel.Labels {
		if metadata.Labels[fmt.Sprint(i)] != label {
			t.Fatal("configured labels differ from checkpoint order")
		}
	}
	core, err := brickrouting.New(cfg)
	if err != nil {
		t.Fatal("cannot initialize real capability and complexity classifiers")
	}
	trace := &regoloTraceRouter{Router: core, key: key}
	s := &Server{cfg: cfg, brickRouter: trace}
	s.brickRouterOnce.Do(func() {})
	original := http.DefaultTransport
	t.Cleanup(func() { http.DefaultTransport = original })
	for _, streaming := range []bool{false, true} {
		t.Run(fmt.Sprintf("stream=%v", streaming), func(t *testing.T) {
			payload := map[string]any{
				"model": "brick-v1-beta", "stream": streaming, "temperature": float64(0),
				"messages": []any{
					map[string]any{"role": "system", "content": "Answer in one sentence without inventing information."},
					map[string]any{"role": "user", "content": "I ordered two monitors but received only one."},
					map[string]any{"role": "assistant", "content": "Do you want to ask about delivery of the second monitor?"},
					map[string]any{"role": "user", "content": "Yes. Write a short message asking customer service when the second monitor will arrive."},
				},
			}
			body, _ := json.Marshal(payload)
			trace.text = extractOpenAIRoutingText(body, cfg)
			trace.result = nil
			s.economicsStore = economics.NewStore()
			rawCapability, err := candle.ClassifyModernBertTextWithProbabilities(trace.text)
			if err != nil {
				t.Fatal("native capability inference failed")
			}
			mass := float64(0)
			for _, probability := range rawCapability.Probabilities {
				mass += float64(probability)
			}
			if len(rawCapability.Probabilities) != 6 || math.Abs(mass-1) > 1e-4 {
				t.Fatalf("native FFI distribution is incomplete: classes=%d mass=%.6f", len(rawCapability.Probabilities), mass)
			}
			classifierCalls, inferenceCalls := 0, 0
			fallbacks := testutil.ToFloat64(metrics.BrickCCClassifyFallback.WithLabelValues())
			var upstreamResponse []byte
			http.DefaultTransport = regoloWireTransport(func(r *http.Request) (*http.Response, error) {
				if r.URL.Scheme != "https" || r.URL.Hostname() != "api.regolo.ai" || r.URL.Path != "/v1/chat/completions" {
					return nil, fmt.Errorf("unexpected outbound destination")
				}
				if r.Header.Get("Authorization") != "Bearer "+key || len(r.Header.Values("Authorization")) != 1 {
					return nil, fmt.Errorf("outbound caller credential mismatch")
				}
				if r.Header.Get("x-selected-model") != "" || r.Header.Get(headers.VSRSelectedModel) != "" {
					t.Error("internal routing header leaked upstream")
				}
				data, err := io.ReadAll(r.Body)
				if err != nil {
					return nil, err
				}
				r.Body = io.NopCloser(bytes.NewReader(data))
				var out map[string]any
				if err := json.Unmarshal(data, &out); err != nil {
					return nil, err
				}
				for _, field := range []string{"max_tokens", "max_completion_tokens", "max_output_tokens"} {
					if _, exists := out[field]; exists {
						t.Errorf("outbound request contains %s", field)
					}
				}
				classifier := out["model"] == "brick-complexity-pro"
				if classifier {
					classifierCalls++
					messages, ok := out["messages"].([]any)
					if !ok || len(messages) != 2 || messages[1].(map[string]any)["content"] != "Classify: "+trace.text || out["logprobs"] != true {
						t.Error("classifier text or confidence request changed")
					}
				} else {
					inferenceCalls++
					if trace.result == nil || out["model"] != trace.result.Model || !cfg.ModelUsesClientKey(trace.result.Model) {
						t.Error("selected model did not reach the Regolo backend")
					}
					for name, value := range payload {
						if name != "model" && !reflect.DeepEqual(out[name], value) {
							t.Errorf("inference changed client field %s", name)
						}
					}
					if streaming && !reflect.DeepEqual(out["stream_options"], map[string]any{"include_usage": true}) {
						t.Error("streaming usage was not requested")
					}
				}
				started := time.Now()
				t.Logf("wire request: model=%s stream=%v messages=preserved caller_key=match token_limits=absent", out["model"], out["stream"])
				response, err := original.RoundTrip(r)
				if err != nil {
					return nil, fmt.Errorf("live Regolo transport failed")
				}
				t.Logf("wire: model=%s status=%d headers_after=%s caller_key=match token_limits=absent", out["model"], response.StatusCode, time.Since(started).Round(time.Millisecond))
				if response.StatusCode != http.StatusOK {
					response.Body.Close()
					return nil, fmt.Errorf("live Regolo status %d", response.StatusCode)
				}
				if !classifier && !streaming {
					upstreamResponse, err = io.ReadAll(response.Body)
					response.Body.Close()
					response.Body = io.NopCloser(bytes.NewReader(upstreamResponse))
				}
				return response, err
			})
			request := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", bytes.NewReader(body))
			request.Header.Set("Authorization", "Bearer "+key)
			request.Header.Set("Content-Type", "application/json")
			w := httptest.NewRecorder()
			started := time.Now()
			s.handleChatCompletions(w, request)
			if w.Code != http.StatusOK {
				t.Fatalf("client HTTP status=%d", w.Code)
			}
			if classifierCalls != 1 || inferenceCalls != 1 || testutil.ToFloat64(metrics.BrickCCClassifyFallback.WithLabelValues()) != fallbacks {
				t.Fatalf("unexpected retries, skipped classification, or classifier fallback: classifier=%d inference=%d", classifierCalls, inferenceCalls)
			}
			route := trace.result
			if route == nil || route.Reason != "skill_vector" || len(route.Capability) != 6 || len(route.Scores) != 3 || route.ComplexityConfidence <= 0 || route.ComplexityConfidence >= 1 {
				t.Fatal("incomplete capability, complexity, or model scoring result")
			}
			for _, probability := range route.Capability {
				if math.IsNaN(probability) || probability < 0 || probability > 1 {
					t.Error("invalid capability probability")
				}
			}
			for i, label := range cfg.SkillRouter.CapabilityModel.Labels {
				if math.Abs(route.Capability[label]-float64(rawCapability.Probabilities[i])/mass) > 1e-6 {
					t.Errorf("capability %s differs from native checkpoint probability", label)
				}
			}
			if w.Header().Get(headers.VSRSelectedModel) != route.Model || w.Header().Get("x-brick-route-reason") != route.Reason {
				t.Error("client routing metadata differs from selected route")
			}
			answer, finish, usage, done := "", "", false, false
			chunks := []string{w.Body.String()}
			if streaming {
				chunks = strings.Split(w.Body.String(), "\n")
			}
			for _, chunk := range chunks {
				if streaming {
					if !strings.HasPrefix(chunk, "data: ") {
						continue
					}
					chunk = strings.TrimSpace(strings.TrimPrefix(chunk, "data: "))
					if chunk == "[DONE]" {
						done = true
						continue
					}
				}
				var decoded struct {
					Model string
					Usage *struct {
						TotalTokens int `json:"total_tokens"`
					}
					Choices []struct {
						Message      struct{ Content string }
						Delta        struct{ Content string }
						FinishReason string `json:"finish_reason"`
					}
				}
				if json.Unmarshal([]byte(chunk), &decoded) != nil || decoded.Model != "brick-v1-beta" {
					t.Fatal("invalid response JSON or public model mask")
				}
				usage = usage || decoded.Usage != nil && decoded.Usage.TotalTokens > 0
				for _, choice := range decoded.Choices {
					answer += choice.Message.Content + choice.Delta.Content
					if choice.FinishReason != "" {
						finish = choice.FinishReason
					}
				}
			}
			if strings.TrimSpace(answer) == "" || finish != "stop" || !usage || streaming && !done {
				t.Fatalf("incomplete response: content=%v finish=%s usage=%v done=%v", strings.TrimSpace(answer) != "", finish, usage, done)
			}
			if !streaming {
				var before, after map[string]any
				json.Unmarshal(upstreamResponse, &before)
				json.Unmarshal(w.Body.Bytes(), &after)
				before["model"] = "brick-v1-beta"
				if !reflect.DeepEqual(before, after) {
					t.Error("response altered beyond public model mask")
				}
			}
			accounted := s.economicsStore.Snapshot()
			if len(accounted) != 1 || accounted[0].Model != route.Model || accounted[0].Requests != 1 || accounted[0].OutputTokens <= 0 {
				t.Error("usage not attributed once to the selected backend model")
			}
			t.Logf("route: capability=%v complexity=%s confidence=%.4f scores=%v", route.Capability, route.ComplexityLabel, route.ComplexityConfidence, route.Scores)
			t.Logf("client: status=200 elapsed=%s model=%s finish=%s usage=present answer=%q", time.Since(started).Round(time.Millisecond), route.Model, finish, strings.TrimSpace(answer))
		})
	}
}
