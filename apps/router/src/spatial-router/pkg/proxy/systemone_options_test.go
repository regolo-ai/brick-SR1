package proxy

import (
	"fmt"
	"testing"
)

func TestSystemOneEffortAcrossProtocols(t *testing.T) {
	for _, field := range []string{`"output_config":{"effort":"%s"}`, `"reasoning":{"effort":"%s"}`, `"reasoning_effort":"%s"`} {
		for effort, expected := range map[string]float64{"low": -1, "medium": -0.5, "high": 0, "xhigh": 0.5, "max": 1} {
			options := requestRoutingOptions([]byte(fmt.Sprintf("{"+field+"}", effort)), map[string]bool{"model": true})
			if options.Knob == nil || *options.Knob != expected || !options.Candidates["model"] {
				t.Fatal(field, effort, options)
			}
		}
	}
	if requestRoutingOptions([]byte(`{}`), nil).Knob != nil {
		t.Fatal("missing effort overrides profile")
	}
}
