// Package brickrouting selects a model using SystemOne capability vectors.
package brickrouting

import (
	"context"
	"fmt"
	"github.com/regolo-ai/brick-SR1/apps/router/src/spatial-router/pkg/observability/metrics"
	"math"
	"sort"
	"strings"
	"time"

	"github.com/regolo-ai/brick-SR1/apps/router/src/spatial-router/pkg/config"
	systemone "github.com/regolo-ai/brick-SR1/systemone"
)

var defaultCapabilities = []string{
	"instruction_following", "coding", "math_reasoning", "world_knowledge", "planning_agentic", "creative_synthesis",
}

type Router struct {
	skillCfg config.SkillRouterConfig
	classify func(string) ([]float64, error)
}

type Result struct {
	Model        string          `json:"model"`
	QueryVector  []float64       `json:"query_vector"`
	ScaledVector []float64       `json:"scaled_vector"`
	Knob         float64         `json:"knob"`
	Distances    []ModelDistance `json:"distances"`
}

type ModelDistance struct {
	Model    string  `json:"model"`
	Distance float64 `json:"distance"`
}

// RoutingOptions combines the request's knob override and eligible models.
type RoutingOptions struct {
	Knob       *float64
	Candidates map[string]bool
}

func New(cfg *config.RouterConfig) (*Router, error) {
	if cfg == nil || !cfg.SkillRouter.Enabled {
		return nil, fmt.Errorf("SystemOne routing is disabled")
	}
	skillCfg, err := canonicalConfig(cfg.SkillRouter)
	if err != nil {
		return nil, err
	}
	path := skillCfg.SystemOne.LocalPath
	if path == "" {
		return nil, fmt.Errorf("skill_router.systemone.local_path is required; install the pinned checkpoint")
	}
	if err := systemone.Init(path); err != nil {
		return nil, err
	}
	return &Router{skillCfg: skillCfg, classify: func(text string) ([]float64, error) {
		return systemone.Classify(text)
	}}, nil
}

// canonicalConfig copies and explicitly reorders configured vectors without mutating the profile.
func canonicalConfig(input config.SkillRouterConfig) (config.SkillRouterConfig, error) {
	if len(input.Capabilities) == 0 {
		input.Capabilities = append([]string(nil), defaultCapabilities...)
	}
	order, err := capabilityLabelOrder(input.Capabilities, defaultCapabilities)
	if err != nil {
		return input, err
	}
	if math.IsNaN(input.Knob) || math.IsInf(input.Knob, 0) || input.Knob < -1 || input.Knob > 1 {
		return input, fmt.Errorf("routing knob must be finite and in [-1, 1]")
	}
	input.Models = append([]config.SkillRouterModelConfig(nil), input.Models...)
	for i := range input.Models {
		model := &input.Models[i]
		if err := validateVector(model.SkillVector, 6); err != nil {
			return input, fmt.Errorf("model %s: %w", model.Model, err)
		}
		original := model.SkillVector
		model.SkillVector = make([]float64, 6)
		for j, index := range order {
			model.SkillVector[j] = original[index]
		}
	}
	input.Capabilities = append([]string(nil), defaultCapabilities...)
	return input, nil
}

func (r *Router) Route(ctx context.Context, text string) (*Result, error) {
	return r.RouteWithOptions(ctx, text, RoutingOptions{})
}

func (r *Router) RouteWithOptions(ctx context.Context, text string, options RoutingOptions) (*Result, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if strings.TrimSpace(text) == "" {
		return nil, fmt.Errorf("no text available for SystemOne routing")
	}
	knob := r.skillCfg.Knob
	if options.Knob != nil {
		knob = *options.Knob
	}
	if math.IsNaN(knob) || math.IsInf(knob, 0) || knob < -1 || knob > 1 {
		return nil, fmt.Errorf("routing knob must be finite and in [-1, 1]")
	}
	allow := intersectAllow(options.Candidates, r.activeAllow())
	if !anyAllowed(r.skillCfg.Models, allow) {
		return nil, fmt.Errorf("no eligible SystemOne candidates")
	}
	started := time.Now()
	query, err := r.classify(text)
	outcome := "success"
	if err != nil {
		outcome = "error"
	}
	metrics.SystemOneDuration.WithLabelValues(outcome).Observe(time.Since(started).Seconds())
	if err != nil {
		return nil, fmt.Errorf("SystemOne inference failed: %w", err)
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	scaled, distances, err := selectSystemOne(query, knob, r.skillCfg.Models, allow)
	if err != nil {
		return nil, err
	}
	return &Result{Model: distances[0].Model, QueryVector: query, ScaledVector: scaled, Knob: knob, Distances: distances}, nil
}

func validateVector(vector []float64, dimensions int) error {
	if len(vector) != dimensions {
		return fmt.Errorf("skill vector has %d dimensions; expected %d", len(vector), dimensions)
	}
	for _, value := range vector {
		if math.IsNaN(value) || math.IsInf(value, 0) || value < 0 || value > 1 {
			return fmt.Errorf("skill vector values must be finite and in [0, 1]")
		}
	}
	return nil
}

func selectSystemOne(query []float64, knob float64, models []config.SkillRouterModelConfig, allow map[string]bool) ([]float64, []ModelDistance, error) {
	if err := validateVector(query, 6); err != nil {
		return nil, nil, err
	}
	if math.IsNaN(knob) || math.IsInf(knob, 0) || knob < -1 || knob > 1 {
		return nil, nil, fmt.Errorf("invalid routing knob")
	}
	scaled := make([]float64, len(query))
	for i, value := range query {
		scaled[i] = math.Min(1, value*(1+0.5*knob))
	}
	var scores []ModelDistance
	for _, model := range models {
		if err := validateVector(model.SkillVector, 6); err != nil {
			return nil, nil, fmt.Errorf("model %s: %w", model.Model, err)
		}
		if !modelAllowed(allow, model.Model) {
			continue
		}
		var sum float64
		for i, value := range scaled {
			delta := value - model.SkillVector[i]
			sum += delta * delta
		}
		distance := math.Sqrt(sum)
		scores = append(scores, ModelDistance{Model: model.Model, Distance: distance})
	}
	if len(scores) == 0 {
		return nil, nil, fmt.Errorf("no eligible SystemOne candidates")
	}
	sort.SliceStable(scores, func(i, j int) bool { return scores[i].Distance < scores[j].Distance })
	return scaled, scores, nil
}

func modelAllowed(allow map[string]bool, model string) bool {
	if allow == nil {
		return true
	}
	return allow[model]
}

func (r *Router) activeAllow() map[string]bool {
	if len(r.skillCfg.ActiveModels) == 0 {
		return nil
	}
	allow := make(map[string]bool, len(r.skillCfg.ActiveModels))
	for _, m := range r.skillCfg.ActiveModels {
		allow[m] = true
	}
	return allow
}

func anyAllowed(models []config.SkillRouterModelConfig, allow map[string]bool) bool {
	for _, m := range models {
		if modelAllowed(allow, m.Model) {
			return true
		}
	}
	return false
}

func intersectAllow(a, b map[string]bool) map[string]bool {
	if a == nil {
		return b
	}
	if b == nil {
		return a
	}
	out := make(map[string]bool)
	for model, ok := range a {
		if ok && b[model] {
			out[model] = true
		}
	}
	return out
}

func capabilityLabelOrder(labels, capabilities []string) ([]int, error) {
	if len(labels) != len(capabilities) {
		return nil, fmt.Errorf("capability labels and routing dimensions differ")
	}
	indices := make(map[string]int, len(labels))
	for i, label := range labels {
		if _, exists := indices[label]; exists {
			return nil, fmt.Errorf("duplicate capability label %q", label)
		}
		indices[label] = i
	}
	order := make([]int, len(capabilities))
	for i, capability := range capabilities {
		index, exists := indices[capability]
		if !exists {
			return nil, fmt.Errorf("missing capability label %q", capability)
		}
		order[i] = index
		delete(indices, capability)
	}
	return order, nil
}
