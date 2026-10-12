package brickrouting

import (
	"context"
	"errors"
	"github.com/regolo-ai/brick-SR1/apps/router/src/spatial-router/pkg/config"
	"math"
	"reflect"
	"testing"
)

func TestSystemOneKnobDistanceAndTie(t *testing.T) {
	query := []float64{.8, .2, 0, 1, .4, .6}
	for _, test := range []struct {
		knob   float64
		scaled []float64
		norm   float64
	}{
		{-1, []float64{.4, .1, 0, .5, .2, .3}, math.Sqrt(.55)},
		{0, []float64{.8, .2, 0, 1, .4, .6}, math.Sqrt(2.2)},
		{1, []float64{1, .3, 0, 1, .6, .9}, math.Sqrt(3.26)},
	} {
		models := []config.SkillRouterModelConfig{{Model: "first", SkillVector: test.scaled}, {Model: "second", SkillVector: test.scaled}, {Model: "zero", SkillVector: make([]float64, 6)}}
		scaled, distances, err := selectSystemOne(query, test.knob, models, nil)
		if err != nil {
			t.Fatal(err)
		}
		for i, value := range scaled {
			if math.Abs(value-test.scaled[i]) > 1e-12 {
				t.Fatal(test.knob, scaled)
			}
		}
		if distances[0].Model != "first" || distances[0].Distance > 1e-12 || distances[1].Model != "second" {
			t.Fatal("exact ties must preserve pool order", distances)
		}
		if math.Abs(distances[2].Distance-test.norm) > 1e-12 {
			t.Fatal("incorrect Euclidean distance", distances)
		}
	}
}

func TestSystemOneDimensionOrderAndRoutingOptions(t *testing.T) {
	input := config.SkillRouterConfig{Capabilities: []string{"coding", "creative_synthesis", "instruction_following", "math_reasoning", "planning_agentic", "world_knowledge"}, Models: []config.SkillRouterModelConfig{{Model: "named", SkillVector: []float64{.1, .2, .3, .4, .5, .6}}}}
	canonical, err := canonicalConfig(input)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(canonical.Models[0].SkillVector, []float64{.3, .1, .4, .6, .5, .2}) || !reflect.DeepEqual(input.Models[0].SkillVector, []float64{.1, .2, .3, .4, .5, .6}) {
		t.Fatal("profile vectors were misordered or mutated")
	}
	calls := 0
	router := &Router{skillCfg: config.SkillRouterConfig{Knob: -.5, Models: []config.SkillRouterModelConfig{{Model: "low", SkillVector: []float64{.2, .2, .2, .2, .2, .2}}, {Model: "high", SkillVector: []float64{.9, .9, .9, .9, .9, .9}}}}, classify: func(string) ([]float64, error) { calls++; return []float64{.6, .6, .6, .6, .6, .6}, nil }}
	result, err := router.Route(context.Background(), "query")
	if err != nil || result.Model != "low" || result.Knob != -.5 {
		t.Fatal(result, err)
	}
	knob := 1.0
	result, err = router.RouteWithOptions(context.Background(), "query", RoutingOptions{Knob: &knob})
	if err != nil || result.Model != "high" || result.Knob != 1 {
		t.Fatal(result, err)
	}
	router.skillCfg.ActiveModels = []string{"high"}
	result, err = router.Route(context.Background(), "query")
	if err != nil || result.Model != "high" {
		t.Fatal("active pool was ignored", result, err)
	}
	before := calls
	if result, err = router.RouteWithOptions(context.Background(), "query", RoutingOptions{Candidates: map[string]bool{"low": true}}); err == nil || result != nil || calls != before {
		t.Fatal("empty intersection must fail before inference")
	}
	router.classify = func(string) ([]float64, error) { return nil, errors.New("local model failed") }
	if result, err = router.Route(context.Background(), "query"); err == nil || result != nil {
		t.Fatal("inference failure produced a fallback", result, err)
	}
}

func TestSystemOneRejectsInvalidVectorsAndPools(t *testing.T) {
	valid := []float64{0, 0, 0, 0, 0, 0}
	models := []config.SkillRouterModelConfig{{Model: "model", SkillVector: valid}}
	for _, value := range []float64{math.NaN(), math.Inf(1), -.01, 1.01} {
		query := append([]float64(nil), valid...)
		query[0] = value
		if _, _, err := selectSystemOne(query, 0, models, nil); err == nil {
			t.Fatal("accepted invalid vector", value)
		}
	}
	if _, _, err := selectSystemOne(valid, 0, models, map[string]bool{}); err == nil {
		t.Fatal("accepted empty pool")
	}
	if _, _, err := selectSystemOne(valid, 2, models, nil); err == nil {
		t.Fatal("accepted invalid knob")
	}
	models[0].SkillVector = []float64{0}
	if _, _, err := selectSystemOne(valid, 0, models, nil); err == nil {
		t.Fatal("accepted invalid model")
	}
}
