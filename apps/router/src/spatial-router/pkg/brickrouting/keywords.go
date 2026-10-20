package brickrouting

import (
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/regolo-ai/brick-SR1/apps/router/src/spatial-router/pkg/config"
)

// compiledKeywordRule is the immutable matching form of a strict keyword rule.
type compiledKeywordRule struct {
	name          string
	model         string
	caseSensitive bool
	all           bool
	needles       []string
}

func compileKeywordRules(rules []config.SkillRouterKeywordRuleConfig) []compiledKeywordRule {
	compiled := make([]compiledKeywordRule, 0, len(rules))
	for _, rule := range rules {
		entry := compiledKeywordRule{
			name:          rule.Name,
			model:         rule.Model,
			caseSensitive: rule.CaseSensitive,
			all:           strings.EqualFold(strings.TrimSpace(rule.Operator), "AND"),
		}
		for _, keyword := range rule.Keywords {
			needle := strings.TrimSpace(keyword)
			if needle == "" {
				continue
			}
			if !rule.CaseSensitive {
				needle = strings.ToLower(needle)
			}
			entry.needles = append(entry.needles, needle)
		}
		if len(entry.needles) == 0 {
			continue
		}
		compiled = append(compiled, entry)
	}
	return compiled
}

func (r *Router) compiledKeywords() []compiledKeywordRule {
	r.keywordsOnce.Do(func() {
		r.keywords = compileKeywordRules(r.skillCfg.Keywords)
	})
	return r.keywords
}

// matchKeyword returns the first rule, in file order, that matches the text.
func (r *Router) matchKeyword(text string) *compiledKeywordRule {
	var lowered string
	var lowerDone bool
	rules := r.compiledKeywords()
	for i := range rules {
		rule := &rules[i]
		haystack := text
		if !rule.caseSensitive {
			if !lowerDone {
				lowered = strings.ToLower(text)
				lowerDone = true
			}
			haystack = lowered
		}
		if rule.matches(haystack) {
			return rule
		}
	}
	return nil
}

func (rule *compiledKeywordRule) matches(text string) bool {
	if rule.all {
		for _, needle := range rule.needles {
			if !containsBounded(text, needle) {
				return false
			}
		}
		return true
	}
	for _, needle := range rule.needles {
		if containsBounded(text, needle) {
			return true
		}
	}
	return false
}

// containsBounded reports whether text contains needle at a word boundary.
// Boundaries are only asserted for keyword edges that are word characters, so
// phrases and symbols (for example "c++") keep their natural semantics.
func containsBounded(text, needle string) bool {
	if needle == "" || len(needle) > len(text) {
		return false
	}
	first, _ := utf8.DecodeRuneInString(needle)
	last, _ := utf8.DecodeLastRuneInString(needle)
	startBoundary := isWordRune(first)
	endBoundary := isWordRune(last)
	for offset := 0; offset < len(text); {
		index := strings.Index(text[offset:], needle)
		if index < 0 {
			return false
		}
		start := offset + index
		end := start + len(needle)
		ok := true
		if startBoundary && start > 0 {
			previous, _ := utf8.DecodeLastRuneInString(text[:start])
			if isWordRune(previous) {
				ok = false
			}
		}
		if ok && endBoundary && end < len(text) {
			next, _ := utf8.DecodeRuneInString(text[end:])
			if isWordRune(next) {
				ok = false
			}
		}
		if ok {
			return true
		}
		_, size := utf8.DecodeRuneInString(text[start:])
		if size == 0 {
			return false
		}
		offset = start + size
	}
	return false
}

func isWordRune(r rune) bool {
	return unicode.IsLetter(r) || unicode.IsDigit(r) || r == '_'
}
