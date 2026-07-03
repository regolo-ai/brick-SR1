package proxy

import (
	"sort"
	"testing"

	"github.com/regolo-ai/brick-SR1/apps/router/src/spatial-router/pkg/config"
	"github.com/regolo-ai/brick-SR1/apps/router/src/spatial-router/pkg/multimodal"
)

// models builds a small pool with the given per-model capability flags.
func mmModels() []config.SkillRouterModelConfig {
	return []config.SkillRouterModelConfig{
		{Model: "text-only"},
		{Model: "vision", HandlesImages: true},
		{Model: "audio", HandlesAudio: true},
		{Model: "omni", HandlesImages: true, HandlesAudio: true},
	}
}

func sortedKeys(m map[string]bool) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

func eqStrs(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func TestDecideMultimodalPlan(t *testing.T) {
	models := mmModels()
	cases := []struct {
		name            string
		modality        multimodal.Modality
		wantPassthrough bool
		wantAllow       []string
	}{
		{
			name:            "text only -> no passthrough",
			modality:        multimodal.Modality{HasText: true},
			wantPassthrough: false,
		},
		{
			name:            "image -> only image-capable models",
			modality:        multimodal.Modality{HasText: true, HasImage: true},
			wantPassthrough: true,
			wantAllow:       []string{"omni", "vision"},
		},
		{
			name:            "audio -> only audio-capable models",
			modality:        multimodal.Modality{HasAudio: true},
			wantPassthrough: true,
			wantAllow:       []string{"audio", "omni"},
		},
		{
			name:            "image+audio -> only models covering BOTH",
			modality:        multimodal.Modality{HasImage: true, HasAudio: true},
			wantPassthrough: true,
			wantAllow:       []string{"omni"},
		},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			plan := decideMultimodalPlan(c.modality, models)
			if plan.passthrough != c.wantPassthrough {
				t.Fatalf("passthrough = %v, want %v", plan.passthrough, c.wantPassthrough)
			}
			if !c.wantPassthrough {
				return
			}
			got := sortedKeys(plan.allow)
			if !eqStrs(got, c.wantAllow) {
				t.Fatalf("allow = %v, want %v", got, c.wantAllow)
			}
		})
	}
}

// When no configured model handles the present raw modality, the plan must fall
// back (passthrough=false) so the caller uses the OCR/STT preprocessing path.
func TestDecideMultimodalPlanFallbackWhenNoCapableModel(t *testing.T) {
	textOnly := []config.SkillRouterModelConfig{{Model: "a"}, {Model: "b"}}
	plan := decideMultimodalPlan(multimodal.Modality{HasImage: true}, textOnly)
	if plan.passthrough {
		t.Fatalf("expected fallback (passthrough=false) when no image-capable model, got allow=%v", plan.allow)
	}

	// image-capable pool but request carries audio -> still a fallback.
	imgPool := []config.SkillRouterModelConfig{{Model: "vision", HandlesImages: true}}
	plan = decideMultimodalPlan(multimodal.Modality{HasAudio: true}, imgPool)
	if plan.passthrough {
		t.Fatalf("expected fallback when no audio-capable model, got allow=%v", plan.allow)
	}
}

func TestMultimodalRoutingPlaceholder(t *testing.T) {
	cases := map[multimodal.Modality]string{
		{HasImage: true}:                 "Analyze the attached image.",
		{HasAudio: true}:                 "Analyze the attached audio.",
		{HasImage: true, HasAudio: true}: "Analyze the attached image and audio.",
		{}:                               "Analyze the attached media.",
	}
	for m, want := range cases {
		if got := multimodalRoutingPlaceholder(m); got != want {
			t.Fatalf("placeholder(%+v) = %q, want %q", m, got, want)
		}
	}
}
