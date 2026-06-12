package brickrouting

import (
	"math"
	"strings"

	"github.com/regolo-ai/brick-SR1/apps/router/src/spatial-router/pkg/config"
)

type keywordMatch struct {
	rule        config.SkillRouterKeywordRule
	order       int
	importance  int
	matched     int
	specificity int
}

func (r *Router) matchKeywords(text string) []keywordMatch {
	matches := make([]keywordMatch, 0)
	for i, rule := range r.skillCfg.KeywordRules {
		if len(rule.Keywords) == 0 {
			continue
		}
		haystack := text
		if !rule.CaseSensitive {
			haystack = strings.ToLower(haystack)
		}

		requiredAll := strings.EqualFold(rule.Operator, "AND")
		matched := 0
		specificity := 0
		for _, keyword := range rule.Keywords {
			needle := keyword
			if !rule.CaseSensitive {
				needle = strings.ToLower(needle)
			}
			if strings.TrimSpace(needle) == "" {
				continue
			}
			if strings.Contains(haystack, needle) {
				matched++
				specificity += len(needle)
			} else if requiredAll {
				matched = 0
				break
			}
		}
		if matched == 0 {
			continue
		}
		importance := rule.Importance
		if importance == 0 {
			importance = 5
		}
		matches = append(matches, keywordMatch{
			rule:        rule,
			order:       i,
			importance:  importance,
			matched:     matched,
			specificity: specificity,
		})
	}
	return matches
}

func bestOverride(matches []keywordMatch) *keywordMatch {
	var best *keywordMatch
	for i := range matches {
		match := matches[i]
		if !strings.EqualFold(match.rule.Mode, "override") {
			continue
		}
		if best == nil || betterKeyword(match, *best) {
			best = &matches[i]
		}
	}
	return best
}

func betterKeyword(a, b keywordMatch) bool {
	if a.importance != b.importance {
		return a.importance > b.importance
	}
	if a.matched != b.matched {
		return a.matched > b.matched
	}
	if a.specificity != b.specificity {
		return a.specificity > b.specificity
	}
	return a.order < b.order
}

func (r *Router) applyKeywordBiases(probabilities []float64, matches []keywordMatch) []float64 {
	out := append([]float64(nil), probabilities...)
	for _, match := range matches {
		mode := strings.ToLower(strings.TrimSpace(match.rule.Mode))
		if mode == "" {
			mode = "bias"
		}
		if mode != "bias" {
			continue
		}
		scale := float64(match.importance) / 10.0
		if len(match.rule.Bias) > 0 {
			for capName, value := range match.rule.Bias {
				if idx, ok := r.capIndex[capName]; ok {
					out[idx] += scale * math.Max(0, value)
				}
			}
			continue
		}
		if idx, ok := r.capIndex[match.rule.Capability]; ok {
			out[idx] += scale
		}
	}
	return normalize(out)
}

func joinedRuleNames(matches []keywordMatch) string {
	if len(matches) == 0 {
		return ""
	}
	names := make([]string, 0, len(matches))
	seen := map[string]bool{}
	for _, match := range matches {
		if match.rule.Name == "" || seen[match.rule.Name] {
			continue
		}
		names = append(names, match.rule.Name)
		seen[match.rule.Name] = true
	}
	return strings.Join(names, ",")
}
