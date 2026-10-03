package pricing

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/regolo-ai/brick-SR1/apps/router/src/spatial-router/pkg/economics"
)

func TestNewRefresher(t *testing.T) {
	r := NewRefresher("test-token")
	if r == nil {
		t.Fatal("expected non-nil refresher")
	}
	if r.Table() != nil {
		t.Error("expected nil table initially")
	}
}

func TestRefresherSetTable(t *testing.T) {
	r := NewRefresher("test-token")
	table := economics.NewPricingTable([]economics.PriceEntry{
		{Model: "test-model", InputPrice: 1.0, OutputPrice: 2.0},
	})
	r.SetTable(table)

	if r.Table() == nil {
		t.Fatal("expected non-nil table after SetTable")
	}
	if r.CacheAge() > CacheTTL {
		t.Error("expected fresh cache age after SetTable")
	}
}

func TestRefresherCacheAge(t *testing.T) {
	r := NewRefresher("test-token")
	age := r.CacheAge()
	if age <= 0 {
		t.Error("expected positive cache age for never-refreshed refresher")
	}
}

func TestRefresherRefreshNoTokenUsesStaticSources(t *testing.T) {
	t.Setenv("OPENROUTER_API_KEY", "")
	r := NewRefresher("")
	if err := r.Refresh(context.Background()); err != nil {
		t.Fatalf("expected refresh to succeed from static sources without a token: %v", err)
	}
	table := r.Table()
	if table == nil {
		t.Fatal("expected non-nil table after refresh")
	}
	entry, ok := table.Price("qwen3.5-122b")
	if !ok || entry.Currency != "EUR" {
		t.Fatalf("expected static Regolo entry for qwen3.5-122b, got %+v (found=%v)", entry, ok)
	}
	if r.CacheAge() > CacheTTL {
		t.Error("expected fresh cache age after successful refresh")
	}
}

func TestRefresherRefreshOpenRouterFailureKeepsPrevious(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer upstream.Close()
	t.Cleanup(func() { openRouterModelsURL = openRouterBaseURL + "/models" })
	openRouterModelsURL = upstream.URL

	r := NewRefresher("test-token")
	r.SetTable(economics.NewPricingTable([]economics.PriceEntry{
		{Model: "seeded-model", InputPrice: 1.0, OutputPrice: 2.0, Currency: "USD"},
	}))
	if err := r.Refresh(context.Background()); err != nil {
		t.Fatalf("expected refresh to degrade gracefully on OpenRouter failure: %v", err)
	}
	table := r.Table()
	if _, ok := table.Price("seeded-model"); !ok {
		t.Error("expected previously known entry to survive a failed OpenRouter refresh")
	}
	if _, ok := table.Price("qwen3.5-122b"); !ok {
		t.Error("expected static Regolo entries to be applied despite OpenRouter failure")
	}
}

func TestRefresherStartStopsOnContextCancel(t *testing.T) {
	r := NewRefresher("test-token")
	ctx, cancel := context.WithCancel(context.Background())

	done := make(chan struct{})
	go func() {
		r.Start(ctx)
		close(done)
	}()

	time.Sleep(100 * time.Millisecond)
	cancel()

	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("refresher did not stop after context cancel")
	}
}
