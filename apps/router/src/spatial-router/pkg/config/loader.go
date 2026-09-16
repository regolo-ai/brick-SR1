package config

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"gopkg.in/yaml.v2"
)

// Parse parses the YAML config file for one runtime instance.
func Parse(configPath string) (*RouterConfig, error) {
	// Resolve profile configuration symlinks before reading.
	resolved, _ := filepath.EvalSymlinks(configPath)
	if resolved == "" {
		resolved = configPath
	}
	data, err := os.ReadFile(resolved)
	if err != nil {
		return nil, fmt.Errorf("failed to read config file: %w", err)
	}

	cfg := &RouterConfig{}
	if err := yaml.UnmarshalStrict(data, cfg); err != nil {
		// Type errors can quote scalar values, including pasted credentials.
		// Preserve precise unknown-field diagnostics but never echo YAML values.
		if typed, ok := err.(*yaml.TypeError); ok {
			for _, detail := range typed.Errors {
				if strings.Contains(detail, "field ") && strings.Contains(detail, " not found in type ") {
					return nil, fmt.Errorf("failed to parse config file: %s", detail)
				}
			}
		}
		return nil, fmt.Errorf("failed to parse config file: invalid YAML or field type")
	}

	// Optional explicit override for the classifier API endpoint.
	if envURL := strings.TrimSpace(os.Getenv("BRICK_CLASSIFIER_URL")); envURL != "" {
		if cfg.ComplexityService == nil {
			cfg.ComplexityService = &ComplexityServiceConfig{Enabled: true}
		}
		cfg.ComplexityService.BaseURL = envURL
	}

	// Validation after parsing
	if err := validateConfigStructure(cfg); err != nil {
		return nil, err
	}

	if err := validateCredentials(cfg); err != nil {
		return nil, err
	}

	if cfg.SkillRouter.Enabled && strings.TrimSpace(cfg.SkillRouter.ComplexityModel.BaseURL) == "" &&
		(cfg.ComplexityService == nil || strings.TrimSpace(cfg.ComplexityService.BaseURL) == "") {
		return nil, fmt.Errorf("skill_router requires a classifier API base_url; the local complexity server was retired")
	}
	if cfg.ComplexityService != nil && cfg.ComplexityService.Enabled && strings.TrimSpace(cfg.ComplexityService.BaseURL) == "" {
		return nil, fmt.Errorf("complexity_service.base_url is required; configure the classifier API")
	}

	return cfg, nil
}
