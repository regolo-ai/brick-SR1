package brickrouting

import (
	"testing"

	"github.com/regolo-ai/brick-SR1/apps/router/src/spatial-router/pkg/config"
)

func mkActiveRouter(active ...string) *Router {
	return &Router{
		skillCfg: config.SkillRouterConfig{
			Models: []config.SkillRouterModelConfig{
				{Model: "small", SkillVector: []float64{0.60, 0.60}},
				{Model: "fit", SkillVector: []float64{0.80, 0.80}},
				{Model: "large", SkillVector: []float64{0.95, 0.95}, CostWeight: 1.0},
			},
			ActiveModels: active,
		},
		mathCfg: newMathConfig(config.SkillRouterMathConfig{}),
	}
}

// TestActiveAllowNilWhenEmpty: an empty/absent active_models yields a nil
// allowlist (admit all), preserving backward compatibility.
func TestActiveAllowNilWhenEmpty(t *testing.T) {
	if got := mkActiveRouter().activeAllow(); got != nil {
		t.Fatalf("empty active_models should give nil allow, got %v", got)
	}
	r := mkActiveRouter()
	if scores := r.scoreModelsWithConfig([]float64{0.5, 0.5}, 0.72, r.activeAllow(), r.mathCfg); len(scores) != 3 {
		t.Fatalf("nil active: expected all 3 models scored, got %d", len(scores))
	}
}

// TestActiveAllowRestrictsCandidates: active_models excludes every model not in
// the list from the scored candidate set.
func TestActiveAllowRestrictsCandidates(t *testing.T) {
	r := mkActiveRouter("small", "large")
	allow := r.activeAllow()
	if allow == nil || len(allow) != 2 {
		t.Fatalf("expected 2-entry allow, got %v", allow)
	}
	scores := r.scoreModelsWithConfig([]float64{0.5, 0.5}, 0.72, allow, r.mathCfg)
	if len(scores) != 2 {
		t.Fatalf("active: expected 2 scores, got %d (%+v)", len(scores), scores)
	}
	for _, s := range scores {
		if s.Model == "fit" {
			t.Fatalf("active_models leaked excluded model %q", s.Model)
		}
	}
}

// TestIntersectAllowMultimodal: the multimodal caller allowlist is AND-ed with
// active_models. Candidacy = handles_modality AND active.
func TestIntersectAllowMultimodal(t *testing.T) {
	active := map[string]bool{"large": true, "fit": true}   // active_models
	modality := map[string]bool{"fit": true, "small": true} // caller (handles modality)
	got := intersectAllow(modality, active)
	if len(got) != 1 || !got["fit"] {
		t.Fatalf("expected only {fit}, got %v", got)
	}
	// nil operands behave as "admit all": nil ∩ x == x.
	if got := intersectAllow(nil, active); len(got) != 2 {
		t.Fatalf("nil ∩ active should equal active, got %v", got)
	}
	if got := intersectAllow(modality, nil); len(got) != 2 {
		t.Fatalf("modality ∩ nil should equal modality, got %v", got)
	}
}

// TestAnyAllowedDetectsEmptyCandidateSet: the text-path guard used by
// RouteWithPreference detects an active_models set that excludes every model.
func TestAnyAllowedDetectsEmptyCandidateSet(t *testing.T) {
	r := mkActiveRouter("small")
	if !anyAllowed(r.skillCfg.Models, r.activeAllow()) {
		t.Fatalf("expected at least one allowed model")
	}
	// A hand-edited active_models referencing an unknown model excludes all.
	bad := mkActiveRouter("ghost")
	if anyAllowed(bad.skillCfg.Models, bad.activeAllow()) {
		t.Fatalf("expected no allowed model for a set that matches nothing")
	}
	// nil allow always admits.
	if !anyAllowed(r.skillCfg.Models, nil) {
		t.Fatalf("nil allow should admit every model")
	}
}
