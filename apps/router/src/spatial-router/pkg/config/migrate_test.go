package config

import (
	"path/filepath"

	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"
	"gopkg.in/yaml.v2"
)

var _ = Describe("deprecated 3.x migration", func() {
	It("migrates override rules, drops lossy fields and maps routing_preference", func() {
		cfg := &RouterConfig{
			ReasoningConfig:   ReasoningConfig{DefaultReasoningEffort: "medium"},
			ComplexityService: &LegacyComplexityServiceConfig{Enabled: true, BaseURL: "https://classifier"},
			SkillRouter: SkillRouterConfig{
				Enabled:       true,
				DynamicEffort: true,
				CapabilityModel: &LegacyCapabilityModelConfig{
					ModelID: "models/modernbert",
				},
				ComplexityModel: &LegacyComplexityModelConfig{ModelID: "regolo/brick-complexity-pro"},
				Math:            &LegacyMathConfig{RoutingPreference: floatPtr(.9), Tau: map[string]float64{"easy": .55}},
				Models:          []SkillRouterModelConfig{{Model: "coder", CostWeight: .5, ReasoningEffort: "medium"}},
				KeywordRules: []LegacyKeywordRuleConfig{{
					Name: "force_coder", Mode: "override", Importance: 10, Model: "coder", Keywords: []string{"refactor"},
				}},
			},
		}

		warnings, err := migrateDeprecated(cfg)
		Expect(err).NotTo(HaveOccurred())
		Expect(warnings).To(ContainElement(ContainSubstring("default_reasoning_effort is removed")))
		Expect(warnings).To(ContainElement(ContainSubstring("complexity_service is removed")))
		Expect(warnings).To(ContainElement(ContainSubstring("capability_model is removed")))
		Expect(warnings).To(ContainElement(ContainSubstring("complexity_model is removed")))
		Expect(warnings).To(ContainElement(ContainSubstring("routing_preference mapped to skill_router.knob=0.90")))
		Expect(warnings).To(ContainElement(ContainSubstring("importance is ignored")))
		Expect(warnings).To(ContainElement(ContainSubstring("cost_weight is removed")))
		Expect(warnings).To(ContainElement(ContainSubstring("reasoning_effort is removed")))

		Expect(cfg.SkillRouter.Knob).To(Equal(.9))
		Expect(cfg.ComplexityService).To(BeNil())
		Expect(cfg.DefaultReasoningEffort).To(BeEmpty())
		Expect(cfg.SkillRouter.Math).To(BeNil())
		Expect(cfg.SkillRouter.CapabilityModel).To(BeNil())
		Expect(cfg.SkillRouter.ComplexityModel).To(BeNil())
		Expect(cfg.SkillRouter.DynamicEffort).To(BeFalse())
		Expect(cfg.SkillRouter.KeywordRules).To(BeNil())
		Expect(cfg.SkillRouter.Keywords).To(Equal([]SkillRouterKeywordRuleConfig{{
			Name: "force_coder", Keywords: []string{"refactor"}, Model: "coder",
		}}))
		Expect(cfg.SkillRouter.Models[0].CostWeight).To(BeZero())
		Expect(cfg.SkillRouter.Models[0].ReasoningEffort).To(BeEmpty())

		data, err := yaml.Marshal(cfg)
		Expect(err).NotTo(HaveOccurred())
		Expect(string(data)).NotTo(ContainSubstring("keyword_rules"))
		Expect(string(data)).NotTo(ContainSubstring("default_reasoning_effort"))
		Expect(string(data)).To(ContainSubstring("keywords:"))
		Expect(string(data)).To(ContainSubstring("knob: 0.9"))
	})

	It("rejects explicit and implicit bias rules", func() {
		for _, mode := range []string{"bias", ""} {
			cfg := &RouterConfig{SkillRouter: SkillRouterConfig{KeywordRules: []LegacyKeywordRuleConfig{{
				Name: "coding_bias", Mode: mode, Capability: "coding", Keywords: []string{"python"},
			}}}}
			_, err := migrateDeprecated(cfg)
			Expect(err).To(HaveOccurred())
			Expect(err.Error()).To(ContainSubstring(`skill_router.keyword_rules[0] ("coding_bias") uses removed mode "bias"`))
		}
	})

	It("rejects bias maps on override rules", func() {
		cfg := &RouterConfig{SkillRouter: SkillRouterConfig{KeywordRules: []LegacyKeywordRuleConfig{{
			Name: "mixed", Mode: "override", Model: "coder", Bias: map[string]float64{"coding": .5}, Keywords: []string{"go"},
		}}}}
		_, err := migrateDeprecated(cfg)
		Expect(err).To(MatchError(ContainSubstring("capability/bias scores")))
	})

	It("rejects keyword_rules and keywords together", func() {
		cfg := &RouterConfig{SkillRouter: SkillRouterConfig{
			Keywords:     []SkillRouterKeywordRuleConfig{{Name: "new", Keywords: []string{"x"}, Model: "coder"}},
			KeywordRules: []LegacyKeywordRuleConfig{{Name: "old", Mode: "override", Model: "coder", Keywords: []string{"y"}}},
		}}
		_, err := migrateDeprecated(cfg)
		Expect(err).To(MatchError(ContainSubstring("cannot be used together")))
	})

	It("does not override an existing knob with routing_preference", func() {
		cfg := &RouterConfig{SkillRouter: SkillRouterConfig{Knob: -.4, Math: &LegacyMathConfig{RoutingPreference: floatPtr(.9)}}}
		warnings, err := migrateDeprecated(cfg)
		Expect(err).NotTo(HaveOccurred())
		Expect(cfg.SkillRouter.Knob).To(Equal(-.4))
		Expect(warnings).To(ContainElement(ContainSubstring("ignored because skill_router.knob is set")))
	})
})

var _ = Describe("ParseWithOptions against the 3.1.1 deploy profile", func() {
	profile := func(name string) string { return filepath.Join("testdata", name) }

	It("stops at the bias rule with a precise diagnostic", func() {
		_, _, err := ParseWithOptions(profile("deploy-3.1.1.yaml"), ParseOptions{})
		Expect(err).To(HaveOccurred())
		Expect(err.Error()).To(ContainSubstring(`skill_router.keyword_rules[1] ("coding_bias") uses removed mode "bias"`))
	})

	It("migrates an override-only profile and reports every dropped field", func() {
		cfg, warnings, err := ParseWithOptions(profile("deploy-3.1.1-override-only.yaml"), ParseOptions{})
		Expect(err).NotTo(HaveOccurred())
		Expect(warnings).NotTo(BeEmpty())
		Expect(cfg.SkillRouter.Knob).To(Equal(.9))
		Expect(cfg.SkillRouter.Keywords).To(HaveLen(1))
		Expect(cfg.SkillRouter.Keywords[0].Name).To(Equal("force_coder"))
		Expect(cfg.SkillRouter.Keywords[0].Model).To(Equal("glm5.2"))
		Expect(cfg.SkillRouter.Keywords[0].Operator).To(Equal("OR"))
		Expect(cfg.SkillRouter.Keywords[0].Keywords).To(ContainElement("refactor"))
		Expect(cfg.SkillRouter.KeywordRules).To(BeNil())
		Expect(cfg.ComplexityService).To(BeNil())
		Expect(cfg.SkillRouter.Math).To(BeNil())
	})

	It("fails a strict parse with a DeprecationError", func() {
		_, warnings, err := ParseWithOptions(profile("deploy-3.1.1-override-only.yaml"), ParseOptions{Strict: true})
		Expect(err).To(HaveOccurred())
		Expect(warnings).NotTo(BeEmpty())
		var deprecation *DeprecationError
		Expect(err).To(BeAssignableToTypeOf(deprecation))
		Expect(err.Error()).To(ContainSubstring("deprecated configuration:"))
	})
})

func floatPtr(value float64) *float64 { return &value }
