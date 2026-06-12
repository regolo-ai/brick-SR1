package config

import (
	"os"
	"path/filepath"
	"testing"
)

func TestSkillRouterModelConfig_ResolveAPIKey(t *testing.T) {
	tmp := t.TempDir()
	keyFile := filepath.Join(tmp, "key.txt")
	if err := os.WriteFile(keyFile, []byte("  sk-from-file\n"), 0o600); err != nil {
		t.Fatalf("write key file: %v", err)
	}

	tests := []struct {
		name     string
		model    SkillRouterModelConfig
		envKey   string
		envVal   string
		fallback string
		want     string
	}{
		{
			name:     "literal APIKey wins over env, file, fallback",
			model:    SkillRouterModelConfig{APIKey: "sk-literal", APIKeyEnv: "X", APIKeyFile: keyFile},
			envKey:   "X",
			envVal:   "sk-env",
			fallback: "sk-fb",
			want:     "sk-literal",
		},
		{
			name:     "env wins over file + fallback when APIKey empty",
			model:    SkillRouterModelConfig{APIKeyEnv: "OPENROUTER_TEST_KEY", APIKeyFile: keyFile},
			envKey:   "OPENROUTER_TEST_KEY",
			envVal:   "sk-from-env",
			fallback: "sk-fb",
			want:     "sk-from-env",
		},
		{
			name:     "file wins over fallback when literal+env empty",
			model:    SkillRouterModelConfig{APIKeyFile: keyFile},
			envKey:   "OPENROUTER_TEST_KEY",
			envVal:   "",
			fallback: "sk-fb",
			want:     "sk-from-file",
		},
		{
			name:     "fallback when nothing configured",
			model:    SkillRouterModelConfig{},
			envKey:   "OPENROUTER_TEST_KEY",
			envVal:   "",
			fallback: "sk-fallback-client-key",
			want:     "sk-fallback-client-key",
		},
		{
			name:     "literal supports env expansion",
			model:    SkillRouterModelConfig{APIKey: "$EXPANDED_TEST_VAR"},
			envKey:   "EXPANDED_TEST_VAR",
			envVal:   "sk-expanded",
			fallback: "x",
			want:     "sk-expanded",
		},
		{
			name:     "env unset falls through to next",
			model:    SkillRouterModelConfig{APIKeyEnv: "DEFINITELY_UNSET_ENV_VAR", APIKeyFile: keyFile},
			envKey:   "",
			envVal:   "",
			fallback: "sk-fb",
			want:     "sk-from-file",
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if tc.envKey != "" {
				if tc.envVal == "" {
					os.Unsetenv(tc.envKey)
				} else {
					os.Setenv(tc.envKey, tc.envVal)
					defer os.Unsetenv(tc.envKey)
				}
			}
			got := tc.model.ResolveAPIKey(tc.fallback)
			if got != tc.want {
				t.Errorf("ResolveAPIKey() = %q, want %q", got, tc.want)
			}
		})
	}
}
