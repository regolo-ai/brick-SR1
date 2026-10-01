package brickrouting

import (
	"testing"

	"github.com/regolo-ai/brick-SR1/apps/router/src/spatial-router/pkg/config"
	"github.com/regolo-ai/brick-SR1/apps/router/src/spatial-router/pkg/economics"
)

func TestScoreModelsPrefersSufficientModelWithoutOverkill(t *testing.T) {
	r := &Router{
		skillCfg: config.SkillRouterConfig{
			Models: []config.SkillRouterModelConfig{
				{Model: "small", SkillVector: []float64{0.60, 0.60}},
				{Model: "fit", SkillVector: []float64{0.80, 0.80}},
				{Model: "large", SkillVector: []float64{0.95, 0.95}, CostWeight: 1.0},
			},
		},
		mathCfg: newMathConfig(config.SkillRouterMathConfig{}),
	}

	scores := r.scoreModels([]float64{0.5, 0.5}, 0.72, nil)
	if len(scores) != 3 {
		t.Fatalf("expected 3 scores, got %d", len(scores))
	}
	if scores[0].Model != "fit" {
		t.Fatalf("expected fit model, got %s (scores=%+v)", scores[0].Model, scores)
	}
}

func TestScoreModelsUsesStaticCostsForMixedCurrencyPool(t *testing.T) {
	newRouter := func() *Router {
		return &Router{
			skillCfg: config.SkillRouterConfig{Models: []config.SkillRouterModelConfig{
				{Model: "usd-model", SkillVector: []float64{0.60, 0.60}, CostWeight: 0.1},
				{Model: "eur-model", SkillVector: []float64{0.80, 0.80}, CostWeight: 0.9},
			}},
			mathCfg: newMathConfig(config.SkillRouterMathConfig{}),
		}
	}

	baseline := newRouter().scoreModels([]float64{0.7, 0.7}, 0.72, nil)
	withMixedPrices := newRouter()
	withMixedPrices.SetPricingTable(economics.NewPricingTable([]economics.PriceEntry{
		{Model: "usd-model", OutputPrice: 10, Currency: "USD"},
		{Model: "eur-model", OutputPrice: 1, Currency: "EUR"},
	}))
	got := withMixedPrices.scoreModels([]float64{0.7, 0.7}, 0.72, nil)
	if len(got) != len(baseline) {
		t.Fatalf("got %d scores, baseline has %d", len(got), len(baseline))
	}
	for i := range got {
		if got[i] != baseline[i] {
			t.Fatalf("mixed currencies changed static score at %d: got %+v, want %+v", i, got[i], baseline[i])
		}
	}
}

func TestScoreModelsUsesDynamicCostsForSingleCurrencyPool(t *testing.T) {
	r := &Router{
		skillCfg: config.SkillRouterConfig{Models: []config.SkillRouterModelConfig{
			{Model: "expensive", SkillVector: []float64{0.7, 0.7}, CostWeight: 0.1},
			{Model: "cheap", SkillVector: []float64{0.7, 0.7}, CostWeight: 0.9},
		}},
		mathCfg: newMathConfig(config.SkillRouterMathConfig{}),
	}
	r.SetPricingTable(economics.NewPricingTable([]economics.PriceEntry{
		{Model: "expensive", OutputPrice: 100, Currency: "USD"},
		{Model: "cheap", OutputPrice: 10, Currency: "USD"},
	}))

	scores := r.scoreModels([]float64{0.7, 0.7}, 0.72, nil)
	if len(scores) != 2 {
		t.Fatalf("expected 2 scores, got %d", len(scores))
	}
	if scores[0].Model != "cheap" {
		t.Fatalf("dynamic prices should override static weights, got scores %+v", scores)
	}
}

func TestScoreModelsAllowlistRestrictsCandidates(t *testing.T) {
	r := &Router{
		skillCfg: config.SkillRouterConfig{
			Models: []config.SkillRouterModelConfig{
				{Model: "small", SkillVector: []float64{0.60, 0.60}},
				{Model: "fit", SkillVector: []float64{0.80, 0.80}},
				{Model: "large", SkillVector: []float64{0.95, 0.95}, CostWeight: 1.0},
			},
		},
		mathCfg: newMathConfig(config.SkillRouterMathConfig{}),
	}

	// nil allowlist: all models eligible, "fit" wins as before.
	if scores := r.scoreModels([]float64{0.5, 0.5}, 0.72, nil); len(scores) != 3 {
		t.Fatalf("nil allow: expected 3 scores, got %d", len(scores))
	}

	// allowlist excludes "fit": only the remaining two are scored, and selection
	// must come from that restricted set.
	allow := map[string]bool{"small": true, "large": true}
	scores := r.scoreModels([]float64{0.5, 0.5}, 0.72, allow)
	if len(scores) != 2 {
		t.Fatalf("allow: expected 2 scores, got %d (%+v)", len(scores), scores)
	}
	for _, s := range scores {
		if s.Model == "fit" {
			t.Fatalf("allowlist leaked excluded model %q", s.Model)
		}
	}
	if scores[0].Model != "large" {
		t.Fatalf("expected best of allowed set = large, got %s", scores[0].Model)
	}
}

// TestScoreModelsWithConfigPreferenceShiftsSelection verifies that overriding
// the routing preference (the per-request mode knob used by RouteWithPreference)
// changes which model wins for the same query. eco (r=-1) should prefer the
// cheaper/smaller model; max (r=+1) should prefer the most capable one.
func TestScoreModelsWithConfigPreferenceShiftsSelection(t *testing.T) {
	r := &Router{
		skillCfg: config.SkillRouterConfig{
			Models: []config.SkillRouterModelConfig{
				{Model: "small", SkillVector: []float64{0.60, 0.60}, CostWeight: 0.1},
				{Model: "fit", SkillVector: []float64{0.80, 0.80}, CostWeight: 0.4},
				{Model: "large", SkillVector: []float64{0.95, 0.95}, CostWeight: 1.0},
			},
		},
		kp: resolveKnobParams(config.SkillRouterMathConfig{}),
	}

	mkCfg := func(pref float64) mathConfig {
		mc := newMathConfig(config.SkillRouterMathConfig{})
		mu, bias, beta, lambda := effectiveParams(r.kp, pref)
		mc.routingPreference = pref
		mc.mu, mc.bias, mc.beta, mc.lambdaOver = mu, bias, beta, lambda
		return mc
	}

	probs := []float64{0.5, 0.5}
	tau := 0.72

	eco := r.scoreModelsWithConfig(probs, tau, nil, mkCfg(-1))
	max := r.scoreModelsWithConfig(probs, tau, nil, mkCfg(1))

	if len(eco) == 0 || len(max) == 0 {
		t.Fatalf("expected scores in both modes")
	}
	if eco[0].Model == "large" {
		t.Fatalf("eco mode should not pick the most expensive model, got %s", eco[0].Model)
	}
	if max[0].Model != "large" {
		t.Fatalf("max mode should pick the most capable model, got %s (scores=%+v)", max[0].Model, max)
	}
}

func TestKeywordOverrideBeatsBias(t *testing.T) {
	r := &Router{
		skillCfg: config.SkillRouterConfig{
			KeywordRules: []config.SkillRouterKeywordRule{
				{Name: "bias", Mode: "bias", Importance: 8, Capability: "coding", Keywords: []string{"python"}},
				{Name: "override", Mode: "override", Importance: 9, Model: "kimi2.6", Keywords: []string{"debug"}},
			},
		},
	}

	matches := r.matchKeywords("debug this python runtime")
	override := bestOverride(matches)
	if override == nil {
		t.Fatal("expected override match")
	}
	if override.rule.Model != "kimi2.6" {
		t.Fatalf("expected kimi2.6 override, got %s", override.rule.Model)
	}
}

func TestFormatVectorRoundsAndBrackets(t *testing.T) {
	got := formatVector([]float64{0.8944559501771971, 0.024997275774892847, 0.03388519508469959, 0.01833133474050271, 0.016109354395705995, 0.012220889827001806})
	if want := "[0.894 0.025 0.034 0.018 0.016 0.012]"; got != want {
		t.Fatalf("formatVector() = %q, want %q", got, want)
	}
	if uniform := 1.0 / 6.0; formatVector([]float64{uniform, uniform, uniform, uniform, uniform, uniform}) != "[0.167 0.167 0.167 0.167 0.167 0.167]" {
		t.Fatalf("uniform vector rendering changed: %s", formatVector([]float64{uniform, uniform, uniform, uniform, uniform, uniform}))
	}
}
