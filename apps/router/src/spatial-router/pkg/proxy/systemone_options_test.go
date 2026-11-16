package proxy

import (
	"fmt"
	"net/http"
	"testing"

	"github.com/regolo-ai/brick-SR1/apps/router/src/spatial-router/pkg/config"
)

func TestSystemOneEffortAcrossProtocols(t *testing.T) {
	for _, field := range []string{`"output_config":{"effort":"%s"}`, `"reasoning":{"effort":"%s"}`, `"reasoning_effort":"%s"`} {
		for effort, expected := range map[string]float64{"low": -1, "medium": -0.5, "high": 0, "xhigh": 0.5, "max": 1} {
			options, err := requestRoutingOptions(nil, []byte(fmt.Sprintf("{"+field+"}", effort)), map[string]bool{"model": true})
			if err != nil || options.Knob == nil || *options.Knob != expected || !options.Candidates["model"] {
				t.Fatal(field, effort, options, err)
			}
		}
	}
	options, err := requestRoutingOptions(nil, []byte(`{}`), nil)
	if err != nil || options.Knob != nil {
		t.Fatal("missing effort overrides profile")
	}
}

func TestKnobHeaderPrecedenceAndValidation(t *testing.T) {
	request, err := http.NewRequest(http.MethodPost, "/v1/chat/completions", nil)
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set(KnobHeader, "-0.75")
	options, err := requestRoutingOptions(request, []byte(`{"reasoning_effort":"max"}`), nil)
	if err != nil || options.Knob == nil || *options.Knob != -0.75 {
		t.Fatal("header knob must win over effort", options, err)
	}
	request.Header.Set(KnobHeader, "2")
	if _, err := requestRoutingOptions(request, nil, nil); err == nil {
		t.Fatal("out-of-range header knob must be rejected")
	}
	request.Header.Set(KnobHeader, "nan")
	if _, err := requestRoutingOptions(request, nil, nil); err == nil {
		t.Fatal("non-numeric header knob must be rejected")
	}
}

func TestKnobToEffortBuckets(t *testing.T) {
	for knob, expected := range map[float64]string{-1: "low", -0.6: "medium", -0.2: "high", 0.2: "xhigh", 0.6: "max", 1: "max"} {
		if got := knobToEffort(knob); got != expected {
			t.Fatalf("knob %v: got %q want %q", knob, got, expected)
		}
	}
}

func TestApplyKnobEffortPreservesClient(t *testing.T) {
	cfg := &config.RouterConfig{}
	preserved := applyKnobEffort([]byte(`{"reasoning":{"effort":"low"}}`), cfg, "model", 1)
	if requestEffort(preserved) != "low" {
		t.Fatal("client effort must be preserved")
	}
	filled := applyKnobEffort([]byte(`{"reasoning":{"effort":""}}`), cfg, "model", 1)
	if requestEffort(filled) != "max" {
		t.Fatal("empty reasoning container must be filled from the knob")
	}
	untouched := applyKnobEffort([]byte(`{}`), cfg, "model", 1)
	if requestEffort(untouched) != "" {
		t.Fatal("missing container must not be invented")
	}
}
