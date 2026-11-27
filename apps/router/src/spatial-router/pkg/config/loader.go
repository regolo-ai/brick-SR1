package config

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"gopkg.in/yaml.v2"
)

// Parse parses the YAML config file for one runtime instance, migrating known
// 3.x fields and ignoring the resulting deprecation warnings.
func Parse(configPath string) (*RouterConfig, error) {
	cfg, _, err := ParseWithOptions(configPath, ParseOptions{})
	return cfg, err
}

// ParseWithOptions parses the YAML config, applies the 3.x migration and
// returns every deprecation warning. With Strict, any warning fails the parse.
func ParseWithOptions(configPath string, options ParseOptions) (*RouterConfig, []string, error) {
	// Resolve profile configuration symlinks before reading.
	resolved, _ := filepath.EvalSymlinks(configPath)
	if resolved == "" {
		resolved = configPath
	}
	data, err := os.ReadFile(resolved)
	if err != nil {
		return nil, nil, fmt.Errorf("failed to read config file: %w", err)
	}

	cfg := &RouterConfig{}
	if err := yaml.UnmarshalStrict(data, cfg); err != nil {
		// Type errors can quote scalar values, including pasted credentials.
		// Preserve precise unknown-field diagnostics but never echo YAML values.
		if typed, ok := err.(*yaml.TypeError); ok {
			for _, detail := range typed.Errors {
				if strings.Contains(detail, "field ") && strings.Contains(detail, " not found in type ") {
					return nil, nil, fmt.Errorf("failed to parse config file: %s", detail)
				}
			}
		}
		return nil, nil, fmt.Errorf("failed to parse config file: invalid YAML or field type")
	}

	warnings, err := migrateDeprecated(cfg)
	if err != nil {
		return nil, nil, err
	}
	if options.Strict && len(warnings) > 0 {
		return nil, warnings, &DeprecationError{Warnings: warnings}
	}

	// Validation after parsing
	if err := validateConfigStructure(cfg); err != nil {
		return nil, nil, err
	}

	if err := validateCredentials(cfg); err != nil {
		return nil, nil, err
	}

	return cfg, warnings, nil
}
