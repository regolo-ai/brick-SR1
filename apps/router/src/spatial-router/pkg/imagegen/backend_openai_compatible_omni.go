package imagegen

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"

	"github.com/regolo-ai/brick-SR1/apps/router/src/spatial-router/pkg/config"
)

// OpenAICompatibleOmniBackend implements the Backend interface for OpenAI-compatible omni
type OpenAICompatibleOmniBackend struct {
	baseURL    string
	model      string
	httpClient *http.Client

	// Default parameters
	defaultSteps    int
	defaultCFGScale float64
	defaultSeed     *int
}

// NewOpenAICompatibleOmniBackend creates a new OpenAI-compatible omni backend
func NewOpenAICompatibleOmniBackend(cfg *config.ImageGenPluginConfig) (Backend, error) {
	omniConfig, ok := cfg.BackendConfig.(*config.OpenAICompatibleOmniImageGenConfig)
	if !ok {
		return nil, fmt.Errorf("invalid backend_config for openai_compatible_omni, expected OpenAICompatibleOmniImageGenConfig")
	}

	if omniConfig.BaseURL == "" {
		return nil, fmt.Errorf("base_url is required for openai_compatible_omni backend")
	}

	timeout := time.Duration(cfg.TimeoutSeconds) * time.Second
	if timeout == 0 {
		timeout = 120 * time.Second
	}

	return &OpenAICompatibleOmniBackend{
		baseURL: omniConfig.BaseURL,
		model:   omniConfig.Model,
		httpClient: &http.Client{
			Timeout: timeout,
		},
		defaultSteps:    getIntOrDefault(omniConfig.NumInferenceSteps, 50),
		defaultCFGScale: getFloatOrDefault(omniConfig.CFGScale, 4.0),
		defaultSeed:     omniConfig.Seed,
	}, nil
}

// Name returns the backend name
func (b *OpenAICompatibleOmniBackend) Name() string {
	return "openai_compatible_omni"
}

// GenerateImage generates an image using OpenAI-compatible omni
func (b *OpenAICompatibleOmniBackend) GenerateImage(ctx context.Context, req *GenerateRequest) (*GenerateResponse, error) {
	// Build OpenAI-compatible omni request
	omniReq := openAICompatibleOmniRequest{
		Messages: []openAICompatibleOmniMessage{
			{Role: "user", Content: req.Prompt},
		},
		Model: b.model,
		ExtraBody: &openAICompatibleOmniExtraBody{
			Width:             getIntOrDefault(req.Width, 1024),
			Height:            getIntOrDefault(req.Height, 1024),
			NumInferenceSteps: getIntOrDefault(req.NumInferenceSteps, b.defaultSteps),
			TrueCFGScale:      getFloatOrDefault(req.GuidanceScale, b.defaultCFGScale),
			Seed:              coalesceIntPtr(req.Seed, b.defaultSeed),
			NegativePrompt:    req.NegativePrompt,
		},
	}

	if req.Model != "" {
		omniReq.Model = req.Model
	}

	// Serialize request
	body, err := json.Marshal(omniReq)
	if err != nil {
		return nil, fmt.Errorf("failed to marshal request: %w", err)
	}

	// Create HTTP request
	httpReq, err := http.NewRequestWithContext(ctx, "POST", b.baseURL+"/v1/chat/completions", bytes.NewBuffer(body))
	if err != nil {
		return nil, fmt.Errorf("failed to create request: %w", err)
	}
	httpReq.Header.Set("Content-Type", "application/json")

	// Execute request
	resp, err := b.httpClient.Do(httpReq)
	if err != nil {
		return nil, fmt.Errorf("request failed: %w", err)
	}
	defer resp.Body.Close()

	// Read response body
	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("failed to read response: %w", err)
	}

	// Check for errors
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("request failed with status %d: %s", resp.StatusCode, string(respBody))
	}

	// Parse response
	var omniResp openAICompatibleOmniResponse
	if unmarshalErr := json.Unmarshal(respBody, &omniResp); unmarshalErr != nil {
		return nil, fmt.Errorf("failed to parse response: %w", unmarshalErr)
	}

	// Extract image URL
	imageURL, err := extractImageURL(&omniResp)
	if err != nil {
		return nil, fmt.Errorf("failed to extract image URL: %w", err)
	}

	return &GenerateResponse{
		ImageURL: imageURL,
		Model:    omniResp.Model,
		Backend:  b.Name(),
	}, nil
}

// HealthCheck checks if the OpenAI-compatible omni server is healthy
func (b *OpenAICompatibleOmniBackend) HealthCheck(ctx context.Context) error {
	httpReq, err := http.NewRequestWithContext(ctx, "GET", b.baseURL+"/health", nil)
	if err != nil {
		return fmt.Errorf("failed to create health check request: %w", err)
	}

	resp, err := b.httpClient.Do(httpReq)
	if err != nil {
		return fmt.Errorf("health check request failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("health check failed with status %d", resp.StatusCode)
	}

	return nil
}

// OpenAI-compatible omni API types
type openAICompatibleOmniRequest struct {
	Messages  []openAICompatibleOmniMessage  `json:"messages"`
	Model     string                         `json:"model,omitempty"`
	ExtraBody *openAICompatibleOmniExtraBody `json:"extra_body,omitempty"`
}

type openAICompatibleOmniMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

type openAICompatibleOmniExtraBody struct {
	Width             int     `json:"width,omitempty"`
	Height            int     `json:"height,omitempty"`
	NumInferenceSteps int     `json:"num_inference_steps,omitempty"`
	TrueCFGScale      float64 `json:"true_cfg_scale,omitempty"`
	Seed              *int    `json:"seed,omitempty"`
	NegativePrompt    string  `json:"negative_prompt,omitempty"`
}

type openAICompatibleOmniResponse struct {
	ID      string                       `json:"id"`
	Object  string                       `json:"object"`
	Created int64                        `json:"created"`
	Model   string                       `json:"model"`
	Choices []openAICompatibleOmniChoice `json:"choices"`
}

type openAICompatibleOmniChoice struct {
	Index        int                             `json:"index"`
	Message      openAICompatibleOmniResponseMsg `json:"message"`
	FinishReason string                          `json:"finish_reason"`
}

type openAICompatibleOmniResponseMsg struct {
	Role    string      `json:"role"`
	Content interface{} `json:"content"`
}

// extractImageURL extracts the image URL from OpenAI-compatible omni response
func extractImageURL(resp *openAICompatibleOmniResponse) (string, error) {
	if len(resp.Choices) == 0 {
		return "", fmt.Errorf("no choices in response")
	}

	content := resp.Choices[0].Message.Content

	// Try to parse as array of content parts
	switch v := content.(type) {
	case []interface{}:
		for _, part := range v {
			partMap, ok := part.(map[string]interface{})
			if !ok {
				continue
			}
			if partMap["type"] == "image_url" {
				if imageURL, ok := partMap["image_url"].(map[string]interface{}); ok {
					if url, ok := imageURL["url"].(string); ok {
						return url, nil
					}
				}
			}
		}
	case string:
		return "", fmt.Errorf("response contains text only, no image")
	}

	return "", fmt.Errorf("no image URL found in response")
}

// Helper functions
func getIntOrDefault(value, defaultValue int) int {
	if value == 0 {
		return defaultValue
	}
	return value
}

func getFloatOrDefault(value, defaultValue float64) float64 {
	if value == 0 {
		return defaultValue
	}
	return value
}

func coalesceIntPtr(a, b *int) *int {
	if a != nil {
		return a
	}
	return b
}
