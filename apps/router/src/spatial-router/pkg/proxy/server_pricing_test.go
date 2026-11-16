package proxy

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/regolo-ai/brick-SR1/apps/router/src/spatial-router/pkg/config"
)

func writePricing(t *testing.T, path, input, output string) {
	t.Helper()
	body := "- model: test-model\n  input_price: " + input + "\n  output_price: " + output + "\n  currency: USD\n"
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatalf("write pricing file: %v", err)
	}
}

func TestPricingReloadsWhenTheFileChanges(t *testing.T) {
	dir := t.TempDir()
	pricingFile := filepath.Join(dir, "pricing.yaml")
	writePricing(t, pricingFile, "1", "2")
	stamp := time.Now().Add(-time.Hour)
	if err := os.Chtimes(pricingFile, stamp, stamp); err != nil {
		t.Fatalf("chtimes: %v", err)
	}

	server := NewServer(&config.RouterConfig{}, filepath.Join(dir, "config.yaml"), 0, dir)
	table, err := server.pricing()
	if err != nil {
		t.Fatalf("pricing: %v", err)
	}
	first, ok := table.Price("test-model")
	if !ok || first.InputPrice != 1 {
		t.Fatalf("unexpected initial price: %+v ok=%v", first, ok)
	}

	// The CLI pricing watcher rewrites the file hourly; a new mtime must win
	// without restarting the router.
	writePricing(t, pricingFile, "3", "4")
	newer := stamp.Add(time.Minute)
	if err := os.Chtimes(pricingFile, newer, newer); err != nil {
		t.Fatalf("chtimes: %v", err)
	}
	table, err = server.pricing()
	if err != nil {
		t.Fatalf("pricing after rewrite: %v", err)
	}
	second, ok := table.Price("test-model")
	if !ok || second.InputPrice != 3 || second.OutputPrice != 4 {
		t.Fatalf("price was not reloaded: %+v ok=%v", second, ok)
	}
}

func TestPricingKeepsLastTableWhenTheFileDisappears(t *testing.T) {
	dir := t.TempDir()
	pricingFile := filepath.Join(dir, "pricing.yaml")
	writePricing(t, pricingFile, "1", "2")

	server := NewServer(&config.RouterConfig{}, filepath.Join(dir, "config.yaml"), 0, dir)
	if _, err := server.pricing(); err != nil {
		t.Fatalf("pricing: %v", err)
	}
	if err := os.Remove(pricingFile); err != nil {
		t.Fatalf("remove: %v", err)
	}
	table, err := server.pricing()
	if err != nil {
		t.Fatalf("cached table should survive a missing file: %v", err)
	}
	if _, ok := table.Price("test-model"); !ok {
		t.Fatal("cached table lost its prices")
	}
}

func TestGetBrickRouterRejectsDisabledRouting(t *testing.T) {
	dir := t.TempDir()
	// Disabled routing fails before loading the local model.
	server := NewServer(&config.RouterConfig{}, filepath.Join(dir, "config.yaml"), 0, dir)
	if _, err := server.getBrickRouter(server.cfg); err == nil {
		t.Fatal("expected router construction to fail with skill router disabled")
	}
}
