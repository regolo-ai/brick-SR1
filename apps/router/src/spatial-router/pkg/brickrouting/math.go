package brickrouting

import (
	"math"

	"github.com/regolo-ai/brick-SR1/apps/router/src/spatial-router/pkg/config"
)

func normalize(values []float64) []float64 {
	out := append([]float64(nil), values...)
	var sum float64
	for i, value := range out {
		if value < 0 || math.IsNaN(value) || math.IsInf(value, 0) {
			out[i] = 0
			continue
		}
		sum += out[i]
	}
	if sum == 0 {
		if len(out) == 0 {
			return out
		}
		uniform := 1.0 / float64(len(out))
		for i := range out {
			out[i] = uniform
		}
		return out
	}
	for i := range out {
		out[i] /= sum
	}
	return out
}

func clamp(value, minValue, maxValue float64) float64 {
	if value < minValue {
		return minValue
	}
	if value > maxValue {
		return maxValue
	}
	return value
}

func logit(value float64) float64 {
	return math.Log(value / (1 - value))
}

func uniformCapabilities(capabilities []string) map[string]float64 {
	out := make(map[string]float64, len(capabilities))
	if len(capabilities) == 0 {
		return out
	}
	value := 1.0 / float64(len(capabilities))
	for _, capability := range capabilities {
		out[capability] = value
	}
	return out
}

func toCapabilityMap(capabilities []string, probabilities []float64) map[string]float64 {
	out := make(map[string]float64, len(capabilities))
	for i, capability := range capabilities {
		if i < len(probabilities) {
			out[capability] = probabilities[i]
		}
	}
	return out
}

func modelTieCost(models []config.SkillRouterModelConfig, name string) float64 {
	for _, model := range models {
		if model.Model == name {
			return model.CostWeight + model.LatencyWeight
		}
	}
	return 0
}
