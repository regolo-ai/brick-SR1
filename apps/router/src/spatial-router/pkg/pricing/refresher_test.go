package pricing

import (
	"context"
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

func TestRefresherRefreshNoToken(t *testing.T) {
	r := NewRefresher("")
	err := r.Refresh(context.Background())
	if err == nil {
		t.Fatal("expected error when no token available")
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
