package proxy

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/regolo-ai/brick-SR1/apps/router/src/spatial-router/pkg/brickrouting"
	"github.com/regolo-ai/brick-SR1/apps/router/src/spatial-router/pkg/config"
	"github.com/regolo-ai/brick-SR1/apps/router/src/spatial-router/pkg/economics"
	"github.com/regolo-ai/brick-SR1/apps/router/src/spatial-router/pkg/sticky"
)

const stickyPricingYAML = `- provider: anthropic
  model: claude-opus
  input_price: 5.0
  output_price: 25.0
  currency: USD
- provider: anthropic
  model: claude-haiku
  input_price: 1.0
  output_price: 5.0
  currency: USD
`

func stickyTestServer(t *testing.T) *Server {
	t.Helper()
	dir := t.TempDir()
	path := filepath.Join(dir, "pricing.yaml")
	if err := os.WriteFile(path, []byte(stickyPricingYAML), 0o644); err != nil {
		t.Fatalf("write pricing.yaml: %v", err)
	}
	table, err := economics.LoadPricingTable(path)
	if err != nil {
		t.Fatalf("load pricing: %v", err)
	}
	return &Server{
		stickyStore:  sticky.New(6 * time.Minute),
		pricingTable: table,
	}
}

func routeWith(model string, scores map[string]float64) *brickrouting.Result {
	r := &brickrouting.Result{Model: model}
	for m, sc := range scores {
		r.Scores = append(r.Scores, brickrouting.ModelScore{Model: m, Score: sc})
	}
	return r
}

const stickyBody = `{"system":"you are a helpful assistant","messages":[{"role":"user","content":"the first user turn"}]}`
const stickyOpenAIBody = `{"messages":[{"role":"system","content":"you are a helpful assistant"},{"role":"user","content":"the first user turn"},{"role":"assistant","content":"working"},{"role":"user","content":"continue"}]}`

func TestApplySticky_NoPrevReturnsKeyAndCandidate(t *testing.T) {
	s := stickyTestServer(t)
	apCfg := &config.AnthropicPassthroughConfig{}
	route := routeWith("claude-opus-4-8", map[string]float64{"claude-opus-4-8": 0.40, "claude-haiku-4-5": 0.50})

	key, model, _, _ := s.applyStickyRouting(apCfg, []byte(stickyBody), route, "claude-opus-4-8", 0)
	if key == "" {
		t.Fatal("expected a non-empty sticky key for an identifiable conversation")
	}
	if model != "claude-opus-4-8" {
		t.Fatalf("no prev: candidate should stand, got %q", model)
	}
}

func TestApplySticky_HoldsBelowMargin(t *testing.T) {
	s := stickyTestServer(t)
	apCfg := &config.AnthropicPassthroughConfig{} // default margin 0.15

	// Identify the conversation and seed it as warm on the cheap model with a
	// large cached prefix, so an upswitch is a costed switch.
	sys, first := extractAnthropicIdentityParts([]byte(stickyBody))
	key := sticky.HashIdentity(sys, first)
	s.stickyStore.Record(key, "claude-haiku-4-5", 40000, false, time.Now())

	// Router now wants opus, but only a small quality gain (0.50 -> 0.45 = 0.05 < margin).
	route := routeWith("claude-opus-4-8", map[string]float64{"claude-opus-4-8": 0.45, "claude-haiku-4-5": 0.50})

	_, model, _, _ := s.applyStickyRouting(apCfg, []byte(stickyBody), route, "claude-opus-4-8", 0)
	if model != "claude-haiku-4-5" {
		t.Fatalf("expected hold on cheap model below margin, got %q", model)
	}
}

func TestApplySticky_SwitchesAboveMargin(t *testing.T) {
	s := stickyTestServer(t)
	apCfg := &config.AnthropicPassthroughConfig{}

	sys, first := extractAnthropicIdentityParts([]byte(stickyBody))
	key := sticky.HashIdentity(sys, first)
	s.stickyStore.Record(key, "claude-haiku-4-5", 40000, false, time.Now())

	// Large quality gain (0.50 -> 0.20 = 0.30 > margin): the switch is justified.
	route := routeWith("claude-opus-4-8", map[string]float64{"claude-opus-4-8": 0.20, "claude-haiku-4-5": 0.50})

	_, model, _, _ := s.applyStickyRouting(apCfg, []byte(stickyBody), route, "claude-opus-4-8", 0)
	if model != "claude-opus-4-8" {
		t.Fatalf("expected switch to opus above margin, got %q", model)
	}
}

func TestApplySticky_CheapDownswitchAllowed(t *testing.T) {
	s := stickyTestServer(t)
	apCfg := &config.AnthropicPassthroughConfig{}

	sys, first := extractAnthropicIdentityParts([]byte(stickyBody))
	key := sticky.HashIdentity(sys, first)
	// Warm on opus with a big prefix; router now wants haiku.
	s.stickyStore.Record(key, "claude-opus-4-8", 40000, false, time.Now())

	route := routeWith("claude-haiku-4-5", map[string]float64{"claude-haiku-4-5": 0.55, "claude-opus-4-8": 0.40})

	// delta = 40000*(1.25*1.0 - 0.10*5.0) = 40000*(1.25-0.5) > 0, so this is NOT a
	// cheap downswitch under these prices; hysteresis applies and the small model
	// loses on score -> hold opus. (Guards against a naive "downswitch always free".)
	_, model, _, _ := s.applyStickyRouting(apCfg, []byte(stickyBody), route, "claude-haiku-4-5", 0)
	if model != "claude-opus-4-8" {
		t.Fatalf("expected hold on opus (haiku prefix reprocess not cheaper), got %q", model)
	}
}

func TestApplySticky_EmptyPromptNoKey(t *testing.T) {
	s := stickyTestServer(t)
	apCfg := &config.AnthropicPassthroughConfig{}
	route := routeWith("claude-opus-4-8", map[string]float64{"claude-opus-4-8": 0.40})

	key, model, _, _ := s.applyStickyRouting(apCfg, []byte(`{"messages":[]}`), route, "claude-opus-4-8", 0)
	if key != "" {
		t.Fatalf("expected empty key for unidentifiable conversation, got %q", key)
	}
	if model != "claude-opus-4-8" {
		t.Fatalf("candidate should stand, got %q", model)
	}
}

func TestApplyBrickSticky_HoldsBelowMargin(t *testing.T) {
	s := stickyTestServer(t)
	brickCfg := &config.BrickConfig{}

	system, first := extractOpenAIIdentityParts([]byte(stickyOpenAIBody))
	if system != "you are a helpful assistant" || first != "the first user turn" {
		t.Fatalf("unexpected OpenAI identity: system=%q first=%q", system, first)
	}
	key := sticky.HashIdentity(system, first)
	s.stickyStore.Record(key, "claude-haiku-4-5", 40000, false, time.Now())

	route := routeWith("claude-opus-4-8", map[string]float64{
		"claude-opus-4-8":  0.45,
		"claude-haiku-4-5": 0.50,
	})
	gotKey, model, _, _ := s.applyBrickStickyRouting(
		brickCfg,
		[]byte(stickyOpenAIBody),
		route,
		"claude-opus-4-8",
		0,
	)
	if gotKey != key {
		t.Fatalf("sticky key = %q, want %q", gotKey, key)
	}
	if model != "claude-haiku-4-5" {
		t.Fatalf("expected Codex/OpenAI hold on warm model, got %q", model)
	}
}
