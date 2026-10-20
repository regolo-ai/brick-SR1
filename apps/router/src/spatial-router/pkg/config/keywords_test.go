package config

import (
	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"
)

func withKeywords(rules ...SkillRouterKeywordRuleConfig) *RouterConfig {
	cfg := skillRouterCfg()
	cfg.SkillRouter.Keywords = rules
	return cfg
}

var _ = Describe("validateSkillRouterConfig keywords", func() {
	It("accepts a strict rule targeting a declared model", func() {
		Expect(validateSkillRouterConfig(withKeywords(SkillRouterKeywordRuleConfig{
			Name: "coder", Keywords: []string{"refactor"}, Model: "opus",
		}))).To(Succeed())
	})

	It("accepts OR and AND operators and case_sensitive", func() {
		Expect(validateSkillRouterConfig(withKeywords(
			SkillRouterKeywordRuleConfig{Name: "or", Keywords: []string{"a"}, Model: "opus"},
			SkillRouterKeywordRuleConfig{Name: "and", Operator: "AND", Keywords: []string{"a", "b"}, Model: "sonnet"},
			SkillRouterKeywordRuleConfig{Name: "case", CaseSensitive: true, Keywords: []string{"A"}, Model: "opus"},
		))).To(Succeed())
	})

	It("rejects an empty rule name", func() {
		err := validateSkillRouterConfig(withKeywords(SkillRouterKeywordRuleConfig{Keywords: []string{"a"}, Model: "opus"}))
		Expect(err).To(MatchError(ContainSubstring("skill_router.keywords[0].name cannot be empty")))
	})

	It("rejects duplicate rule names", func() {
		err := validateSkillRouterConfig(withKeywords(
			SkillRouterKeywordRuleConfig{Name: "dup", Keywords: []string{"a"}, Model: "opus"},
			SkillRouterKeywordRuleConfig{Name: "dup", Keywords: []string{"b"}, Model: "opus"},
		))
		Expect(err).To(MatchError(ContainSubstring(`duplicate skill_router.keywords[1].name "dup"`)))
	})

	It("rejects rules without keywords", func() {
		err := validateSkillRouterConfig(withKeywords(SkillRouterKeywordRuleConfig{Name: "empty", Model: "opus"}))
		Expect(err).To(MatchError(ContainSubstring("keywords cannot be empty")))
	})

	It("rejects blank keyword entries", func() {
		err := validateSkillRouterConfig(withKeywords(SkillRouterKeywordRuleConfig{Name: "blank", Keywords: []string{"ok", "  "}, Model: "opus"}))
		Expect(err).To(MatchError(ContainSubstring("cannot contain empty entries")))
	})

	It("rejects an unknown operator", func() {
		err := validateSkillRouterConfig(withKeywords(SkillRouterKeywordRuleConfig{Name: "xor", Operator: "XOR", Keywords: []string{"a"}, Model: "opus"}))
		Expect(err).To(MatchError(ContainSubstring("operator must be OR or AND")))
	})

	It("requires a model", func() {
		err := validateSkillRouterConfig(withKeywords(SkillRouterKeywordRuleConfig{Name: "naked", Keywords: []string{"a"}}))
		Expect(err).To(MatchError(ContainSubstring("model is required")))
	})

	It("rejects a model outside skill_router.models", func() {
		err := validateSkillRouterConfig(withKeywords(SkillRouterKeywordRuleConfig{Name: "ghost", Keywords: []string{"a"}, Model: "ghost"}))
		Expect(err).To(MatchError(ContainSubstring(`model "ghost" is not listed in skill_router.models`)))
	})

	It("rejects a model excluded by active_models", func() {
		cfg := skillRouterCfg("sonnet")
		cfg.SkillRouter.Keywords = []SkillRouterKeywordRuleConfig{{Name: "inactive", Keywords: []string{"a"}, Model: "opus"}}
		err := validateSkillRouterConfig(cfg)
		Expect(err).To(MatchError(ContainSubstring(`model "opus" is not an active routing candidate`)))
	})
})
