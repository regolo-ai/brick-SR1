package config

import (
	"strings"
	"testing"
)

func TestBrickConfigValidate(t *testing.T) {
	validConfig := BrickConfig{
		Enabled:        true,
		STTModel:       "faster-whisper-large-v3",
		STTEndpoint:    "https://api.regolo.ai/v1/audio/transcriptions",
		OCRModel:       "deepseek-ocr",
		OCREndpoint:    "https://api.regolo.ai/v1/chat/completions",
		VisionModel:    "qwen3-vl-32b",
		VisionEndpoint: "https://api.regolo.ai/v1/chat/completions",
	}

	t.Run("valid config passes", func(t *testing.T) {
		if err := validConfig.Validate(); err != nil {
			t.Errorf("Validate() unexpected error: %v", err)
		}
	})

	t.Run("disabled config always passes", func(t *testing.T) {
		cfg := BrickConfig{Enabled: false}
		if err := cfg.Validate(); err != nil {
			t.Errorf("Validate() should pass when disabled, got: %v", err)
		}
	})

	t.Run("text-only brick config passes without modality providers", func(t *testing.T) {
		cfg := BrickConfig{Enabled: true}
		if err := cfg.Validate(); err != nil {
			t.Errorf("Validate() should pass for text-only brick config, got: %v", err)
		}
	})

	missingFields := []struct {
		name  string
		setup func(*BrickConfig)
		want  string // substring expected in error
	}{
		{
			name:  "missing vision_model",
			setup: func(c *BrickConfig) { c.VisionModel = "" },
			want:  "vision_model",
		},
		{
			name:  "missing vision_endpoint",
			setup: func(c *BrickConfig) { c.VisionEndpoint = "" },
			want:  "vision_endpoint",
		},
		{
			name:  "missing stt_model",
			setup: func(c *BrickConfig) { c.STTModel = "" },
			want:  "stt_model",
		},
		{
			name:  "missing stt_endpoint",
			setup: func(c *BrickConfig) { c.STTEndpoint = "" },
			want:  "stt_endpoint",
		},
		{
			name:  "missing ocr_model",
			setup: func(c *BrickConfig) { c.OCRModel = "" },
			want:  "ocr_model",
		},
		{
			name:  "missing ocr_endpoint",
			setup: func(c *BrickConfig) { c.OCREndpoint = "" },
			want:  "ocr_endpoint",
		},
	}

	for _, tc := range missingFields {
		t.Run(tc.name, func(t *testing.T) {
			cfg := validConfig // copy
			tc.setup(&cfg)
			err := cfg.Validate()
			if err == nil {
				t.Fatalf("Validate() should fail for %s", tc.name)
			}
			if !strings.Contains(err.Error(), tc.want) {
				t.Errorf("error %q should mention %q", err.Error(), tc.want)
			}
		})
	}

	t.Run("invalid URL detected", func(t *testing.T) {
		cfg := validConfig
		cfg.VisionEndpoint = "://bad-url"
		err := cfg.Validate()
		if err == nil {
			t.Fatal("Validate() should fail for invalid URL")
		}
		if !strings.Contains(err.Error(), "vision_endpoint") {
			t.Errorf("error %q should mention vision_endpoint", err.Error())
		}
	})

	t.Run("URL without host detected", func(t *testing.T) {
		cfg := validConfig
		cfg.STTEndpoint = "/just/a/path"
		err := cfg.Validate()
		if err == nil {
			t.Fatal("Validate() should fail for URL without host")
		}
		if !strings.Contains(err.Error(), "stt_endpoint") {
			t.Errorf("error %q should mention stt_endpoint", err.Error())
		}
	})
}

func TestBrickConfigGetOCRMinTextLen(t *testing.T) {
	t.Run("default value", func(t *testing.T) {
		cfg := &BrickConfig{}
		if got := cfg.GetOCRMinTextLen(); got != 10 {
			t.Errorf("GetOCRMinTextLen() = %d, want 10", got)
		}
	})

	t.Run("configured value", func(t *testing.T) {
		cfg := &BrickConfig{OCRMinTextLen: 25}
		if got := cfg.GetOCRMinTextLen(); got != 25 {
			t.Errorf("GetOCRMinTextLen() = %d, want 25", got)
		}
	})
}

func TestBrickConfigCacheAwareDefaults(t *testing.T) {
	cfg := &BrickConfig{}
	if got := cfg.EffectiveRoutingMode(); got != RoutingModeSmartSqueeze {
		t.Errorf("EffectiveRoutingMode() = %q, want %q", got, RoutingModeSmartSqueeze)
	}
	if got := cfg.EffectiveStickyTTLSeconds(); got != 1800 {
		t.Errorf("EffectiveStickyTTLSeconds() = %d, want 1800", got)
	}
	if got := cfg.EffectiveStickyScoreMargin(); got != 0.15 {
		t.Errorf("EffectiveStickyScoreMargin() = %v, want 0.15", got)
	}

	cfg.RoutingMode = RoutingModeOff
	cfg.StickyTTLSeconds = 900
	cfg.StickyScoreMargin = 0.25
	if got := cfg.EffectiveRoutingMode(); got != RoutingModeOff {
		t.Errorf("configured EffectiveRoutingMode() = %q, want %q", got, RoutingModeOff)
	}
	if got := cfg.EffectiveStickyTTLSeconds(); got != 900 {
		t.Errorf("configured EffectiveStickyTTLSeconds() = %d, want 900", got)
	}
	if got := cfg.EffectiveStickyScoreMargin(); got != 0.25 {
		t.Errorf("configured EffectiveStickyScoreMargin() = %v, want 0.25", got)
	}
}
