package brickrouting

import (
	"reflect"
	"testing"
)

func TestCapabilityLabelOrder(t *testing.T) {
	checkpoint := []string{"instruction_following", "coding", "math_reasoning", "world_knowledge", "planning_agentic", "creative_synthesis"}
	order, err := capabilityLabelOrder(checkpoint, []string{"coding", "creative_synthesis", "instruction_following", "math_reasoning", "planning_agentic", "world_knowledge"})
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(order, []int{1, 5, 0, 2, 4, 3}) {
		t.Fatalf("checkpoint probabilities would be assigned to wrong capabilities: %v", order)
	}
	canonical, err := capabilityLabelOrder(checkpoint, defaultCapabilities)
	if err != nil || !reflect.DeepEqual(canonical, []int{0, 1, 2, 3, 4, 5}) {
		t.Fatalf("invalid canonical order: %v %v", canonical, err)
	}
	for _, labels := range [][]string{
		{"coding"},
		{"coding", "coding", "math_reasoning", "world_knowledge", "planning_agentic", "creative_synthesis"},
		{"unknown", "coding", "math_reasoning", "world_knowledge", "planning_agentic", "creative_synthesis"},
	} {
		if _, err := capabilityLabelOrder(labels, defaultCapabilities); err == nil {
			t.Errorf("accepted mismatched checkpoint labels: %v", labels)
		}
	}
}
