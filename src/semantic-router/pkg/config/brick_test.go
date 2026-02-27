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

func TestGetAutoModelNames(t *testing.T) {
	t.Run("without brick", func(t *testing.T) {
		cfg := &RouterConfig{
			RouterOptions: RouterOptions{AutoModelName: "MoM"},
		}
		names := cfg.GetAutoModelNames()
		if len(names) != 1 || names[0] != "MoM" {
			t.Errorf("GetAutoModelNames() = %v, want [MoM]", names)
		}
	})

	t.Run("with brick enabled", func(t *testing.T) {
		cfg := &RouterConfig{
			RouterOptions: RouterOptions{AutoModelName: "MoM"},
			MyModelExtension: MyModelExtension{
				Brick: BrickConfig{Enabled: true},
			},
		}
		names := cfg.GetAutoModelNames()
		if len(names) != 2 {
			t.Fatalf("GetAutoModelNames() = %v, want 2 entries", names)
		}
		if names[0] != "MoM" {
			t.Errorf("names[0] = %q, want MoM", names[0])
		}
		if names[1] != "brick" {
			t.Errorf("names[1] = %q, want brick", names[1])
		}
	})
}

func TestIsAutoModelNameWithBrick(t *testing.T) {
	cfg := &RouterConfig{
		RouterOptions: RouterOptions{AutoModelName: "MoM"},
		MyModelExtension: MyModelExtension{
			Brick: BrickConfig{Enabled: true},
		},
	}

	if !cfg.IsAutoModelName("brick") {
		t.Error("IsAutoModelName(brick) should be true when brick is enabled")
	}
	if !cfg.IsAutoModelName("MoM") {
		t.Error("IsAutoModelName(MoM) should be true")
	}
	if !cfg.IsAutoModelName("auto") {
		t.Error("IsAutoModelName(auto) should always be true")
	}
	if cfg.IsAutoModelName("gpt-4") {
		t.Error("IsAutoModelName(gpt-4) should be false")
	}
}
