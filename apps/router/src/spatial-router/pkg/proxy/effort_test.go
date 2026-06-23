package proxy

import (
	"encoding/json"
	"testing"

	"github.com/regolo-ai/brick-SR1/apps/router/src/spatial-router/pkg/config"
)

func ptrF(v float64) *float64 { return &v }

func TestResolveEffortLevel(t *testing.T) {
	cases := []struct {
		name  string
		label string
		r     float64
		want  int
	}{
		// eco window [0,1]
		{"eco-easy", "easy", -1, 1},
		{"eco-medium", "medium", -1, 1},
		{"eco-hard", "hard", -1, 1},
		// lite window [0,2]
		{"lite-easy", "easy", -0.5, 1},
		{"lite-hard", "hard", -0.5, 2},
		// mid window [1,3] (passthrough)
		{"mid-easy", "easy", 0, 1},
		{"mid-medium", "medium", 0, 2},
		{"mid-hard", "hard", 0, 3},
		// pro window [2,4]
		{"pro-easy", "easy", 0.5, 2},
		{"pro-hard", "hard", 0.5, 3},
		// max window [3,5]
		{"max-easy", "easy", 1, 3},
		{"max-hard", "hard", 1, 3},
		// unknown/skipped label -> medium base
		{"skipped", "skipped", 0, 2},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := resolveEffortLevel(c.label, c.r); got != c.want {
				t.Fatalf("resolveEffortLevel(%q, %v) = %d, want %d", c.label, c.r, got, c.want)
			}
		})
	}
}

func TestApplyEffortAnthropic(t *testing.T) {
	cfgMax := &config.RouterConfig{}
	cfgMax.SkillRouter.Math.RoutingPreference = ptrF(1) // max -> window [3,5]

	// hard @ max -> L3 -> claude "high"
	out := applyEffortAnthropic([]byte(`{"model":"claude-opus-4-8","messages":[]}`), cfgMax, "hard")
	var raw map[string]interface{}
	if err := json.Unmarshal(out, &raw); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	oc, ok := raw["output_config"].(map[string]interface{})
	if !ok {
		t.Fatalf("missing output_config: %s", out)
	}
	if oc["effort"] != "high" {
		t.Fatalf("effort = %v, want high", oc["effort"])
	}

	// easy @ eco -> L0 -> claude "low"; overwrites a client-sent xhigh
	cfgEco := &config.RouterConfig{}
	cfgEco.SkillRouter.Math.RoutingPreference = ptrF(-1)
	out = applyEffortAnthropic([]byte(`{"output_config":{"effort":"xhigh"}}`), cfgEco, "easy")
	_ = json.Unmarshal(out, &raw)
	oc, _ = raw["output_config"].(map[string]interface{})
	if oc["effort"] != "low" {
		t.Fatalf("clamped effort = %v, want low", oc["effort"])
	}
}

func TestStripUnsupportedFieldsForHaiku(t *testing.T) {
	// Inject effort then strip for Haiku: output_config.effort must be gone.
	cfg := &config.RouterConfig{}
	cfg.SkillRouter.Math.RoutingPreference = ptrF(1)
	body := applyEffortAnthropic([]byte(`{"model":"claude-haiku-4-5"}`), cfg, "hard")
	stripped := stripUnsupportedFieldsForModel(body, "claude-haiku-4-5")
	var raw map[string]interface{}
	if err := json.Unmarshal(stripped, &raw); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if _, ok := raw["output_config"]; ok {
		t.Fatalf("output_config should be removed for haiku, got: %s", stripped)
	}
	// Sonnet keeps it.
	kept := stripUnsupportedFieldsForModel(body, "claude-sonnet-4-6")
	_ = json.Unmarshal(kept, &raw)
	if _, ok := raw["output_config"].(map[string]interface{}); !ok {
		t.Fatalf("output_config should be kept for sonnet, got: %s", kept)
	}
}

func TestModelSupportsEffort(t *testing.T) {
	if modelSupportsEffort("claude-haiku-4-5") {
		t.Fatal("haiku should not support effort")
	}
	if !modelSupportsEffort("claude-opus-4-8") {
		t.Fatal("opus should support effort")
	}
}

func TestClientEffortToPreference(t *testing.T) {
	cases := []struct {
		effort string
		want   float64
	}{
		{"low", -1.0},
		{"medium", -0.5},
		{"high", 0.0},
		{"xhigh", 0.5},
		{"max", 1.0},
		{"", 0.0},        // unset -> mid
		{"bogus", 0.0},   // unknown -> mid
		{"  HIGH ", 0.0}, // case + whitespace tolerant
	}
	for _, c := range cases {
		if got := clientEffortToPreference(c.effort); got != c.want {
			t.Fatalf("clientEffortToPreference(%q) = %v, want %v", c.effort, got, c.want)
		}
	}
}

func TestExtractClientEffort(t *testing.T) {
	if got := extractClientEffort([]byte(`{"output_config":{"effort":"xhigh"}}`)); got != "xhigh" {
		t.Fatalf("got %q, want xhigh", got)
	}
	if got := extractClientEffort([]byte(`{"messages":[]}`)); got != "" {
		t.Fatalf("absent effort should be empty, got %q", got)
	}
	if got := extractClientEffort([]byte(`not json`)); got != "" {
		t.Fatalf("invalid json should be empty, got %q", got)
	}
}

func TestExtractRequestedModel(t *testing.T) {
	if got := extractRequestedModel([]byte(`{"model":"brick-claude"}`)); got != "brick-claude" {
		t.Fatalf("got %q, want brick-claude", got)
	}
	if got := extractRequestedModel([]byte(`{"model":"claude-opus-4-8"}`)); got != "claude-opus-4-8" {
		t.Fatalf("got %q, want claude-opus-4-8", got)
	}
	if got := extractRequestedModel([]byte(`{}`)); got != "" {
		t.Fatalf("absent model should be empty, got %q", got)
	}
}

func TestLadderFromTau(t *testing.T) {
	cases := []struct {
		tau  float64
		want int
	}{
		{0.0, 0}, {0.49, 0},
		{0.50, 1}, {0.55, 1}, {0.61, 1}, // easy anchor
		{0.62, 2}, {0.72, 2}, {0.75, 2}, // medium anchor
		{0.76, 3}, {0.85, 3},
		{0.86, 4}, {0.88, 4}, {0.92, 4}, // hard anchor
		{0.93, 5}, {1.0, 5},
	}
	for _, c := range cases {
		if got := ladderFromTau(c.tau); got != c.want {
			t.Fatalf("ladderFromTau(%v) = %d, want %d", c.tau, got, c.want)
		}
	}
}

func TestAutonomousEffortLevel(t *testing.T) {
	cases := []struct {
		name  string
		tau   float64
		under float64
		want  int
	}{
		// Neutral under-capacity (between low and high): pure ladder.
		{"easy-neutral", 0.55, 0.4, 1},
		{"medium-neutral", 0.72, 0.4, 2},
		{"hard-neutral", 0.88, 0.4, 4},
		// Comfortable headroom (under <= old stretchLow): no decrement, pure ladder.
		{"easy-headroom", 0.55, 0.10, 1},
		{"hard-headroom", 0.88, 0.05, 4},
		// Stretched model (under >= stretchHigh): +1.
		{"medium-stretched", 0.72, 0.90, 3},
		{"hard-stretched", 0.88, 1.50, 5},
		// Clamp floor/ceiling.
		{"floor", 0.10, 0.0, 0},
		{"ceiling", 0.99, 2.0, 5},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := autonomousEffortLevel(c.tau, c.under); got != c.want {
				t.Fatalf("autonomousEffortLevel(%v, %v) = %d, want %d", c.tau, c.under, got, c.want)
			}
		})
	}
}

func TestApplyEffortAnthropicLevel(t *testing.T) {
	// Opus L4 -> "xhigh", creating output_config when absent.
	out := applyEffortAnthropicLevel([]byte(`{"model":"claude-opus-4-8"}`), 4, "claude-opus-4-8")
	var raw map[string]interface{}
	if err := json.Unmarshal(out, &raw); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	oc, ok := raw["output_config"].(map[string]interface{})
	if !ok {
		t.Fatalf("missing output_config: %s", out)
	}
	if oc["effort"] != "xhigh" {
		t.Fatalf("opus L4 effort = %v, want xhigh", oc["effort"])
	}

	// Sonnet rejects xhigh: L4 must collapse to "high".
	out = applyEffortAnthropicLevel([]byte(`{"model":"claude-sonnet-4-6"}`), 4, "claude-sonnet-4-6")
	_ = json.Unmarshal(out, &raw)
	oc, _ = raw["output_config"].(map[string]interface{})
	if oc["effort"] != "high" {
		t.Fatalf("sonnet L4 effort = %v, want high (no xhigh)", oc["effort"])
	}

	// Sonnet L5 still reaches "max".
	out = applyEffortAnthropicLevel([]byte(`{"model":"claude-sonnet-4-6"}`), 5, "claude-sonnet-4-6")
	_ = json.Unmarshal(out, &raw)
	oc, _ = raw["output_config"].(map[string]interface{})
	if oc["effort"] != "max" {
		t.Fatalf("sonnet L5 effort = %v, want max", oc["effort"])
	}

	// L0 -> "low", overwriting a client-sent xhigh.
	out = applyEffortAnthropicLevel([]byte(`{"output_config":{"effort":"xhigh"}}`), 0, "claude-opus-4-8")
	_ = json.Unmarshal(out, &raw)
	oc, _ = raw["output_config"].(map[string]interface{})
	if oc["effort"] != "low" {
		t.Fatalf("effort = %v, want low", oc["effort"])
	}
}
