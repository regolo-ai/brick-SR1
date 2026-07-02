package config

import (
	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"
)

// skillRouterCfg builds a minimal skill_router config that passes validation,
// so tests can vary only active_models.
func skillRouterCfg(active ...string) *RouterConfig {
	return &RouterConfig{
		BackendModels: BackendModels{
			ModelConfig: map[string]ModelParams{
				"opus":   {},
				"sonnet": {},
			},
		},
		SkillRouter: SkillRouterConfig{
			Enabled:      true,
			Capabilities: []string{"coding", "world_knowledge"},
			CapabilityModel: SkillRouterCapabilityModelConfig{
				ModelID: "models/cap",
			},
			Models: []SkillRouterModelConfig{
				{Model: "opus", SkillVector: []float64{0.9, 0.9}},
				{Model: "sonnet", SkillVector: []float64{0.8, 0.8}},
			},
			ActiveModels: active,
		},
	}
}

var _ = Describe("validateSkillRouterConfig active_models", func() {
	It("accepts an empty active_models (all models are candidates)", func() {
		Expect(validateSkillRouterConfig(skillRouterCfg())).To(Succeed())
	})

	It("accepts active_models referencing declared models", func() {
		Expect(validateSkillRouterConfig(skillRouterCfg("opus", "sonnet"))).To(Succeed())
	})

	It("accepts a strict subset", func() {
		Expect(validateSkillRouterConfig(skillRouterCfg("opus"))).To(Succeed())
	})

	It("rejects an active model not declared in skill_router.models", func() {
		err := validateSkillRouterConfig(skillRouterCfg("ghost"))
		Expect(err).To(HaveOccurred())
		Expect(err.Error()).To(ContainSubstring("is not defined in skill_router.models"))
	})

	It("rejects duplicate active models", func() {
		err := validateSkillRouterConfig(skillRouterCfg("opus", "opus"))
		Expect(err).To(HaveOccurred())
		Expect(err.Error()).To(ContainSubstring("duplicate"))
	})
})
