package brickrouting

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/regolo-ai/brick-SR1/apps/router/src/spatial-router/pkg/config"
)

func six(value float64) []float64 {
	return []float64{value, value, value, value, value, value}
}

func keywordRouter(rules []config.SkillRouterKeywordRuleConfig, models ...string) (*Router, *int) {
	vectors := make([]config.SkillRouterModelConfig, 0, len(models))
	for _, model := range models {
		vectors = append(vectors, config.SkillRouterModelConfig{Model: model, SkillVector: six(.5)})
	}
	calls := 0
	return &Router{
		skillCfg: config.SkillRouterConfig{Models: vectors, Keywords: rules},
		classify: func(context.Context, string) ([]float64, error) {
			calls++
			return six(.5), nil
		},
	}, &calls
}

func TestKeywordMatchingUsesWordBoundaries(t *testing.T) {
	for _, test := range []struct {
		name    string
		keyword string
		text    string
		want    bool
	}{
		{"bare word", "refactor", "please refactor this", true},
		{"word prefix", "refactor", "refactoring is hard", false},
		{"suffix word", "class", "classify this", false},
		{"underscore is a word character", "class", "_class_name", false},
		{"punctuation boundary", "class", "the class, finally", true},
		{"phrase", "write a function", "please write a function that parses", true},
		{"phrase prefix only", "write a function", "rewrite a function", false},
		{"accented word", "perché", "dimmi perché funziona", true},
		{"accented uppercase", "perché", "Dimmelo PERCHÉ", true},
		{"punctuation edge", "c++", "use c++ please", true},
		{"start of text", "debug", "debug this", true},
		{"end of text", "debug", "please debug", true},
	} {
		t.Run(test.name, func(t *testing.T) {
			rule := compiledKeywordRule{needles: []string{strings.ToLower(test.keyword)}}
			if got := rule.matches(strings.ToLower(test.text)); got != test.want {
				t.Fatalf("keyword %q against %q: got %v, want %v", test.keyword, test.text, got, test.want)
			}
		})
	}
}

func TestKeywordMatchingIsCaseSensitiveWhenRequested(t *testing.T) {
	rule := compiledKeywordRule{caseSensitive: true, needles: []string{"Class"}}
	if rule.matches("class body") {
		t.Fatal("case-sensitive rule matched a different case")
	}
	if !rule.matches("the Class body") {
		t.Fatal("case-sensitive rule missed an exact match")
	}
}

func TestKeywordRulesFirstMatchWinsInFileOrder(t *testing.T) {
	router, calls := keywordRouter([]config.SkillRouterKeywordRuleConfig{
		{Name: "broad", Keywords: []string{"deploy"}, Model: "first"},
		{Name: "specific", Keywords: []string{"deploy now"}, Model: "second"},
	}, "first", "second")
	result, err := router.Route(context.Background(), "deploy now")
	if err != nil {
		t.Fatal(err)
	}
	if result.Model != "first" || result.MatchedRule != "broad" || result.Reason != ReasonKeyword {
		t.Fatalf("file order changed: %+v", result)
	}
	if *calls != 0 {
		t.Fatal("SystemOne must not run for a keyword route")
	}
}

func TestKeywordRulesAndOperator(t *testing.T) {
	router, _ := keywordRouter([]config.SkillRouterKeywordRuleConfig{
		{Name: "both", Operator: "AND", Keywords: []string{"build", "docker"}, Model: "ops"},
	}, "ops")
	if result, err := router.Route(context.Background(), "build a docker image"); err != nil || result.Model != "ops" {
		t.Fatal(result, err)
	}
	result, err := router.RouteWithOptions(context.Background(), "build an image", RoutingOptions{})
	if err != nil || result.Reason != ReasonClassifier || result.MatchedRule != "" {
		t.Fatalf("a partial AND match must fall through to the classifier: %+v %v", result, err)
	}
}

func TestKeywordRuleIneligibleCandidate(t *testing.T) {
	router, calls := keywordRouter([]config.SkillRouterKeywordRuleConfig{
		{Name: "coder", Keywords: []string{"refactor"}, Model: "coder"},
	}, "coder", "vision")
	_, err := router.RouteWithOptions(context.Background(), "refactor this", RoutingOptions{Candidates: map[string]bool{"vision": true}})
	var ineligible *KeywordRuleIneligibleError
	if !errors.As(err, &ineligible) || ineligible.Rule != "coder" || ineligible.Model != "coder" {
		t.Fatalf("expected an ineligible keyword error, got %v", err)
	}
	if *calls != 0 {
		t.Fatal("SystemOne must not run for a blocked keyword match")
	}
}

func TestKeywordRouteKeepsKnobAndReason(t *testing.T) {
	router, _ := keywordRouter([]config.SkillRouterKeywordRuleConfig{
		{Name: "coder", Keywords: []string{"refactor"}, Model: "coder"},
	}, "coder")
	knob := .7
	result, err := router.RouteWithOptions(context.Background(), "refactor this", RoutingOptions{Knob: &knob})
	if err != nil || result.Knob != .7 || result.Reason != ReasonKeyword || len(result.Distances) != 0 {
		t.Fatalf("unexpected keyword result: %+v %v", result, err)
	}
	result, err = router.RouteWithOptions(context.Background(), "explain this", RoutingOptions{})
	if err != nil || result.Reason != ReasonClassifier {
		t.Fatalf("classifier path lost its reason: %+v %v", result, err)
	}
}

func TestKeywordRuleEmptyAndOperatorDefault(t *testing.T) {
	router, _ := keywordRouter([]config.SkillRouterKeywordRuleConfig{
		{Name: "or", Keywords: []string{"alpha", "beta"}, Model: "m"},
	}, "m")
	for _, text := range []string{"alpha", "beta"} {
		if result, err := router.Route(context.Background(), text); err != nil || result.MatchedRule != "or" {
			t.Fatalf("%q did not match the default OR operator: %v", text, err)
		}
	}
	if !router.compiledKeywords()[0].matches("alpha") {
		t.Fatal("default operator must be OR")
	}
}
