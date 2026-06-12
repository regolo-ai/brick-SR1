package brickrouting

import (
	"encoding/json"
	"math"
	"os"
	"testing"

	"github.com/regolo-ai/brick-SR1/apps/router/src/spatial-router/pkg/config"
)

// Golden parity test against the canonical Python reference implementation
// (packages/evals/baselines/sweep_knob_aggressive.py). The golden file is
// produced by packages/evals/scripts/gen_paper_golden.py; regenerate it with
//
//	python3 packages/evals/scripts/gen_paper_golden.py
//
// whenever the locked production parameters change.

const parityTol = 1e-9

type goldenFile struct {
	LockedParams map[string]float64 `json:"locked_params"`
	Models       []goldenModel      `json:"models"`
	ClipMin      float64            `json:"clip_min"`
	ClipMax      float64            `json:"clip_max"`
	Cases        []goldenCase       `json:"cases"`
}

type goldenModel struct {
	Model       string    `json:"model"`
	SkillVector []float64 `json:"skill_vector"`
	CostWeight  float64   `json:"cost_weight"`
}

type goldenCase struct {
	ID                int           `json:"id"`
	RoutingPreference float64       `json:"routing_preference"`
	Probabilities     []float64     `json:"probabilities"`
	TauQuery          float64       `json:"tau_query"`
	Effective         goldenEff     `json:"effective"`
	Scores            []goldenScore `json:"scores"`
	ArgminModel       string        `json:"argmin_model"`
}

type goldenEff struct {
	Mu     float64 `json:"mu"`
	Bias   float64 `json:"bias"`
	Beta   float64 `json:"beta"`
	Lambda float64 `json:"lambda"`
}

type goldenScore struct {
	Model           string  `json:"model"`
	Distance        float64 `json:"distance"`
	Score           float64 `json:"score"`
	ExpectedSuccess float64 `json:"expected_success"`
}

func loadGolden(t *testing.T) goldenFile {
	t.Helper()
	raw, err := os.ReadFile("testdata/paper_golden.json")
	if err != nil {
		t.Fatalf("read golden file: %v", err)
	}
	var g goldenFile
	if err := json.Unmarshal(raw, &g); err != nil {
		t.Fatalf("parse golden file: %v", err)
	}
	if len(g.Cases) == 0 {
		t.Fatal("golden file has no cases")
	}
	return g
}

// routerForCase builds a Router with only the fields scoreModels touches, so
// the test exercises the production code path without classifiers.
func routerForCase(g goldenFile, preference float64) *Router {
	f := func(v float64) *float64 { return &v }
	mathCfg := config.SkillRouterMathConfig{
		RoutingPreference: f(preference),
		ComplexityMu:      g.LockedParams["complexity_mu"],
		ComplexityBias:    f(g.LockedParams["complexity_bias"]),
		CostPenaltyBeta:   g.LockedParams["cost_penalty_beta"],
		OverPenaltyLambda: g.LockedParams["over_penalty_lambda"],
		PreferencePower:   g.LockedParams["preference_power"],
		MaxMuMultiplier:   g.LockedParams["max_mu_multiplier"],
		MaxBiasShift:      f(g.LockedParams["max_bias_shift"]),
		MaxCostRelief:     g.LockedParams["max_cost_relief"],
		MaxOverRelief:     g.LockedParams["max_over_relief"],
		MinMuMultiplier:   g.LockedParams["min_mu_multiplier"],
		MinBiasShift:      f(g.LockedParams["min_bias_shift"]),
		MinCostBoost:      g.LockedParams["min_cost_boost"],
		MinOverBoost:      g.LockedParams["min_over_boost"],
		ClipMin:           g.ClipMin,
		ClipMax:           g.ClipMax,
		// Disable the tie-epsilon refinement so ordering matches the pure
		// argmin of the Python reference (which has no tie handling).
		TieEpsilon: 1e-15,
	}
	models := make([]config.SkillRouterModelConfig, 0, len(g.Models))
	for _, m := range g.Models {
		models = append(models, config.SkillRouterModelConfig{
			Model:       m.Model,
			SkillVector: m.SkillVector,
			CostWeight:  m.CostWeight,
		})
	}
	return &Router{
		skillCfg: config.SkillRouterConfig{Models: models},
		mathCfg:  newMathConfig(mathCfg),
	}
}

func TestEffectiveParamsMatchesPaper(t *testing.T) {
	g := loadGolden(t)
	for _, c := range g.Cases {
		r := routerForCase(g, c.RoutingPreference)
		if d := math.Abs(r.mathCfg.mu - c.Effective.Mu); d > parityTol {
			t.Fatalf("case %d r=%v: mu=%v want %v (diff %v)", c.ID, c.RoutingPreference, r.mathCfg.mu, c.Effective.Mu, d)
		}
		if d := math.Abs(r.mathCfg.bias - c.Effective.Bias); d > parityTol {
			t.Fatalf("case %d r=%v: bias=%v want %v (diff %v)", c.ID, c.RoutingPreference, r.mathCfg.bias, c.Effective.Bias, d)
		}
		if d := math.Abs(r.mathCfg.beta - c.Effective.Beta); d > parityTol {
			t.Fatalf("case %d r=%v: beta=%v want %v (diff %v)", c.ID, c.RoutingPreference, r.mathCfg.beta, c.Effective.Beta, d)
		}
		if d := math.Abs(r.mathCfg.lambdaOver - c.Effective.Lambda); d > parityTol {
			t.Fatalf("case %d r=%v: lambda=%v want %v (diff %v)", c.ID, c.RoutingPreference, r.mathCfg.lambdaOver, c.Effective.Lambda, d)
		}
	}
}

func TestScoreModelsMatchesPaper(t *testing.T) {
	g := loadGolden(t)
	for _, c := range g.Cases {
		r := routerForCase(g, c.RoutingPreference)
		scores := r.scoreModels(c.Probabilities, c.TauQuery, nil)
		if len(scores) != len(c.Scores) {
			t.Fatalf("case %d: got %d scores, want %d", c.ID, len(scores), len(c.Scores))
		}

		// Selection parity: top-ranked model == Python argmin.
		if scores[0].Model != c.ArgminModel {
			t.Fatalf("case %d r=%v: selected %s, want %s (scores=%+v)", c.ID, c.RoutingPreference, scores[0].Model, c.ArgminModel, scores)
		}

		// Numeric parity per model (golden order is the config order).
		byModel := map[string]ModelScore{}
		for _, s := range scores {
			byModel[s.Model] = s
		}
		for _, want := range c.Scores {
			got, ok := byModel[want.Model]
			if !ok {
				t.Fatalf("case %d: model %s missing from scores", c.ID, want.Model)
			}
			if d := math.Abs(got.Distance - want.Distance); d > parityTol {
				t.Fatalf("case %d %s: distance=%v want %v (diff %v)", c.ID, want.Model, got.Distance, want.Distance, d)
			}
			if d := math.Abs(got.Score - want.Score); d > parityTol {
				t.Fatalf("case %d %s: score=%v want %v (diff %v)", c.ID, want.Model, got.Score, want.Score, d)
			}
			if d := math.Abs(got.ExpectedSuccess - want.ExpectedSuccess); d > parityTol {
				t.Fatalf("case %d %s: expected_success=%v want %v (diff %v)", c.ID, want.Model, got.ExpectedSuccess, want.ExpectedSuccess, d)
			}
		}
	}
}

// TestEffectiveParamsNeutralAtZero pins the r=0 invariant: every effective
// parameter must equal its base value.
func TestEffectiveParamsNeutralAtZero(t *testing.T) {
	kp := knobParams{
		complexityMu:      0.345170,
		complexityBias:    0.822235,
		costPenaltyBeta:   0.230778,
		overPenaltyLambda: 0.045207,
		preferencePower:   2.920351,
		maxMuMultiplier:   13.034935,
		maxBiasShift:      5.294173,
		maxCostRelief:     6559.073066,
		maxOverRelief:     49.547940,
		minMuMultiplier:   0.081493,
		minBiasShift:      -1.349259,
		minCostBoost:      8.834043,
		minOverBoost:      1002.068256,
	}
	mu, bias, beta, lambda := effectiveParams(kp, 0)
	if mu != kp.complexityMu || bias != kp.complexityBias || beta != kp.costPenaltyBeta || lambda != kp.overPenaltyLambda {
		t.Fatalf("r=0 must be neutral: got mu=%v bias=%v beta=%v lambda=%v", mu, bias, beta, lambda)
	}
}
