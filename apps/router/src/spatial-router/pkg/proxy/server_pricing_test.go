package proxy

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/regolo-ai/brick-SR1/apps/router/src/spatial-router/pkg/config"
	"github.com/regolo-ai/brick-SR1/apps/router/src/spatial-router/pkg/pricing"
)

func TestNewServerInitializesPricingRefresher(t *testing.T) {
	dir := t.TempDir()
	pricingFile := filepath.Join(dir, "pricing.yaml")
	if err := os.WriteFile(pricingFile, []byte(`- model: test-model
  input_price: 1
  output_price: 2
  currency: USD
`), 0o600); err != nil {
		t.Fatalf("write pricing file: %v", err)
	}

	server := NewServer(&config.RouterConfig{}, filepath.Join(dir, "config.yaml"), 0, dir)
	if server.pricingRefresher == nil {
		t.Fatal("NewServer did not initialize the pricing refresher")
	}
	if server.pricingRefresher.Table() == nil {
		t.Fatal("NewServer did not seed the refresher with the existing pricing table")
	}
}

func TestStalePricingCacheCancelsServerContext(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan struct{})
	go func() {
		stopWhenPricingStale(ctx, cancel, pricing.NewRefresher(""), time.Millisecond)
		close(done)
	}()

	select {
	case <-ctx.Done():
	case <-time.After(time.Second):
		t.Fatal("stale pricing cache did not cancel the server context")
	}
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("pricing cache watcher did not stop after cancellation")
	}
}
