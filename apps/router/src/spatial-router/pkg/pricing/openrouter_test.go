package pricing

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestFetchOpenRouterPrices_Success(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer test-token" {
			t.Errorf("expected Authorization header, got %s", r.Header.Get("Authorization"))
		}
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{
			"data": [
				{
					"id": "anthropic/claude-3-opus",
					"pricing": {
						"prompt": "0.000015",
						"completion": "0.000075"
					}
				},
				{
					"id": "openai/gpt-4",
					"pricing": {
						"prompt": "0.000030",
						"completion": "0.000060"
					}
				}
			]
		}`))
	}))
	defer server.Close()

	origURL := openRouterModelsURL
	openRouterModelsURL = server.URL
	defer func() { openRouterModelsURL = origURL }()

	prices, err := FetchOpenRouterPrices("test-token")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if len(prices) != 2 {
		t.Fatalf("expected 2 prices, got %d", len(prices))
	}

	opus := prices["anthropic/claude-3-opus"]
	if opus.InputPrice != 15.0 || opus.OutputPrice != 75.0 {
		t.Errorf("unexpected opus prices: input=%f output=%f", opus.InputPrice, opus.OutputPrice)
	}

	gpt4 := prices["openai/gpt-4"]
	if gpt4.InputPrice != 30.0 || gpt4.OutputPrice != 60.0 {
		t.Errorf("unexpected gpt4 prices: input=%f output=%f", gpt4.InputPrice, gpt4.OutputPrice)
	}
}

func TestFetchOpenRouterPricesContextCancellation(t *testing.T) {
	started := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		close(started)
		<-r.Context().Done()
	}))
	defer server.Close()

	origURL := openRouterModelsURL
	openRouterModelsURL = server.URL
	defer func() { openRouterModelsURL = origURL }()

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		_, err := FetchOpenRouterPricesContext(ctx, "test-token")
		done <- err
	}()
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("request did not reach test server")
	}
	cancel()
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("expected canceled request to return an error")
		}
	case <-time.After(time.Second):
		t.Fatal("request did not return after context cancellation")
	}
}

func TestFetchOpenRouterPrices_NoToken(t *testing.T) {
	_, err := FetchOpenRouterPrices("")
	if err == nil {
		t.Fatal("expected error for empty token")
	}
}

func TestFetchOpenRouterPrices_HTTPError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
	}))
	defer server.Close()

	origURL := openRouterModelsURL
	openRouterModelsURL = server.URL
	defer func() { openRouterModelsURL = origURL }()

	_, err := FetchOpenRouterPrices("bad-token")
	if err == nil {
		t.Fatal("expected error for HTTP 401")
	}
}

func TestFetchOpenRouterPrices_InvalidJSON(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{invalid json`))
	}))
	defer server.Close()

	origURL := openRouterModelsURL
	openRouterModelsURL = server.URL
	defer func() { openRouterModelsURL = origURL }()

	_, err := FetchOpenRouterPrices("test-token")
	if err == nil {
		t.Fatal("expected error for invalid JSON")
	}
}

func TestFetchOpenRouterPrices_EmptyData(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"data": []}`))
	}))
	defer server.Close()

	origURL := openRouterModelsURL
	openRouterModelsURL = server.URL
	defer func() { openRouterModelsURL = origURL }()

	_, err := FetchOpenRouterPrices("test-token")
	if err == nil {
		t.Fatal("expected error for empty data")
	}
}

func TestGetRegoloPrices(t *testing.T) {
	prices := GetRegoloPrices()
	if len(prices) == 0 {
		t.Fatal("expected non-empty regolo prices")
	}
	for model, price := range prices {
		if price.InputPrice <= 0 || price.OutputPrice <= 0 {
			t.Errorf("invalid price for %s: input=%f output=%f", model, price.InputPrice, price.OutputPrice)
		}
	}
}
