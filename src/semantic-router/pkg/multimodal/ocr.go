package multimodal

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/vllm-project/semantic-router/src/semantic-router/pkg/config"
)

// validateImageURL checks that an image URL is safe to fetch server-side.
// Blocks private/link-local IPs, localhost, and non-HTTPS schemes to prevent SSRF.
func validateImageURL(rawURL string) error {
	u, err := url.Parse(rawURL)
	if err != nil {
		return fmt.Errorf("invalid image URL: %w", err)
	}

	// Allow data: URIs (base64-encoded images) — these don't make network requests
	if u.Scheme == "data" {
		return nil
	}

	// Only allow HTTPS
	if !strings.EqualFold(u.Scheme, "https") {
		return fmt.Errorf("image URL must use HTTPS scheme, got %q", u.Scheme)
	}

	hostname := u.Hostname()
	if hostname == "" {
		return fmt.Errorf("image URL has no hostname")
	}

	// Block localhost variants
	lower := strings.ToLower(hostname)
	if lower == "localhost" || lower == "ip6-localhost" || lower == "ip6-loopback" {
		return fmt.Errorf("image URL must not point to localhost")
	}

	// Resolve hostname and check all IPs
	ips, err := net.LookupHost(hostname)
	if err != nil {
		return fmt.Errorf("cannot resolve image URL host %q: %w", hostname, err)
	}

	for _, ipStr := range ips {
		ip := net.ParseIP(ipStr)
		if ip == nil {
			continue
		}
		if isPrivateOrReserved(ip) {
			return fmt.Errorf("image URL resolves to private/reserved IP %s", ipStr)
		}
	}

	return nil
}

// isPrivateOrReserved returns true if the IP is in a private, loopback,
// link-local, or otherwise reserved range.
func isPrivateOrReserved(ip net.IP) bool {
	return ip.IsLoopback() ||
		ip.IsPrivate() ||
		ip.IsLinkLocalUnicast() ||
		ip.IsLinkLocalMulticast() ||
		ip.IsUnspecified()
}

// OCRImage sends an image URL to the OCR model (deepseek-ocr style) and returns extracted text.
// Uses the chat completions format: sends the image as an image_url content part with an OCR prompt.
func OCRImage(ctx context.Context, imageURL string, cfg *config.BrickConfig, apiKey string) (string, error) {
	// Validate image URL to prevent SSRF
	if err := validateImageURL(imageURL); err != nil {
		return "", fmt.Errorf("SSRF protection: %w", err)
	}

	// Build a chat completions request with the image
	reqBody := map[string]interface{}{
		"model": cfg.OCRModel,
		"messages": []map[string]interface{}{
			{
				"role": "user",
				"content": []map[string]interface{}{
					{
						"type": "text",
						"text": "Extract all text from this image. Return only the extracted text, nothing else.",
					},
					{
						"type":      "image_url",
						"image_url": map[string]string{"url": imageURL},
					},
				},
			},
		},
		"max_tokens": 1024,
	}

	bodyBytes, err := json.Marshal(reqBody)
	if err != nil {
		return "", fmt.Errorf("marshaling OCR request: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, cfg.OCREndpoint, bytes.NewReader(bodyBytes))
	if err != nil {
		return "", fmt.Errorf("creating OCR request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	if apiKey != "" {
		req.Header.Set("Authorization", "Bearer "+apiKey)
	}

	client := &http.Client{Timeout: 2 * time.Minute}
	resp, err := client.Do(req)
	if err != nil {
		return "", fmt.Errorf("OCR request failed: %w", err)
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", fmt.Errorf("reading OCR response: %w", err)
	}

	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("OCR API returned %d: %s", resp.StatusCode, string(respBody))
	}

	// Parse OpenAI chat completions response
	var result struct {
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
	}
	if err := json.Unmarshal(respBody, &result); err != nil {
		return "", fmt.Errorf("parsing OCR response: %w", err)
	}

	if len(result.Choices) == 0 {
		return "", fmt.Errorf("OCR response has no choices")
	}

	return result.Choices[0].Message.Content, nil
}
