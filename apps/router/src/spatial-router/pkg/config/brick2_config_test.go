package config

import "testing"

func TestParseBrick2RootConfig(t *testing.T) {
	cfg, err := Parse("../../../../config.yaml")
	if err != nil {
		t.Fatalf("parse root config: %v", err)
	}
	if !cfg.SkillRouter.Enabled {
		t.Fatal("expected skill_router.enabled=true")
	}
	if len(cfg.SkillRouter.Models) != 3 {
		t.Fatalf("expected 3 skill router models, got %d", len(cfg.SkillRouter.Models))
	}
}
