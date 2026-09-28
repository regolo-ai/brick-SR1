package pricing

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"time"
)

const (
	openRouterBaseURL = "https://openrouter.ai/api/v1"
	requestTimeout    = 30 * time.Second
)

var openRouterModelsURL = openRouterBaseURL + "/models"

type OpenRouterPrice struct {
	InputPrice  float64
	OutputPrice float64
}

type openRouterResponse struct {
	Data []struct {
		ID      string `json:"id"`
		Pricing struct {
			Prompt     string `json:"prompt"`
			Completion string `json:"completion"`
		} `json:"pricing"`
	} `json:"data"`
}

func FetchOpenRouterPrices(token string) (map[string]OpenRouterPrice, error) {
	return FetchOpenRouterPricesContext(context.Background(), token)
}

func FetchOpenRouterPricesContext(ctx context.Context, token string) (map[string]OpenRouterPrice, error) {
	if token == "" {
		token = os.Getenv("OPENROUTER_API_KEY")
	}
	if token == "" {
		return nil, fmt.Errorf("pricing: OpenRouter API key not set")
	}

	client := &http.Client{Timeout: requestTimeout}
	req, err := http.NewRequestWithContext(ctx, "GET", openRouterModelsURL, nil)
	if err != nil {
		return nil, fmt.Errorf("pricing: failed to create request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("User-Agent", "brick-pricing/1.0")

	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("pricing: OpenRouter request failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("pricing: OpenRouter returned %d: %s", resp.StatusCode, string(body))
	}

	var orResp openRouterResponse
	if err := json.NewDecoder(resp.Body).Decode(&orResp); err != nil {
		return nil, fmt.Errorf("pricing: failed to decode OpenRouter response: %w", err)
	}

	prices := make(map[string]OpenRouterPrice, len(orResp.Data))
	for _, model := range orResp.Data {
		if model.ID == "" {
			continue
		}
		var inputPrice, outputPrice float64
		fmt.Sscanf(model.Pricing.Prompt, "%g", &inputPrice)
		fmt.Sscanf(model.Pricing.Completion, "%g", &outputPrice)
		inputPrice *= 1_000_000
		outputPrice *= 1_000_000
		if inputPrice > 0 && outputPrice > 0 {
			prices[model.ID] = OpenRouterPrice{InputPrice: inputPrice, OutputPrice: outputPrice}
		}
	}

	if len(prices) == 0 {
		return nil, fmt.Errorf("pricing: no valid prices returned from OpenRouter")
	}

	return prices, nil
}
