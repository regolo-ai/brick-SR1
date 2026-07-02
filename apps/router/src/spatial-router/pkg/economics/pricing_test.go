package economics

import (
	"os"
	"path/filepath"
	"testing"
)

const testPricingYAML = `
- provider: anthropic
  model: claude-haiku
  input_price: 1.0
  output_price: 5.0
  currency: USD
  source_url: https://platform.claude.com/docs/en/about-claude/pricing
  source: fetched
  fetched_at: '2026-07-02T15:53:23Z'
- provider: anthropic
  model: claude-sonnet
  input_price: 3.0
  output_price: 15.0
  currency: USD
  source_url: https://platform.claude.com/docs/en/about-claude/pricing
  source: fetched
  fetched_at: '2026-07-02T15:53:23Z'
- provider: anthropic
  model: claude-opus
  input_price: 5.0
  output_price: 25.0
  currency: USD
  source_url: https://platform.claude.com/docs/en/about-claude/pricing
  source: fetched
  fetched_at: '2026-07-02T15:53:23Z'
`

func writeTestPricingFile(t *testing.T, contents string) string {
	t.Helper()
	dir := t.TempDir()
	path := filepath.Join(dir, "pricing.yaml")
	if err := os.WriteFile(path, []byte(contents), 0o644); err != nil {
		t.Fatalf("failed to write test pricing file: %v", err)
	}
	return path
}

func TestLoadPricingTable_ValidFile(t *testing.T) {
	path := writeTestPricingFile(t, testPricingYAML)

	table, err := LoadPricingTable(path)
	if err != nil {
		t.Fatalf("LoadPricingTable returned error: %v", err)
	}

	haiku, ok := table.Price("claude-haiku")
	if !ok {
		t.Fatalf("expected claude-haiku to be present")
	}
	if haiku.Provider != "anthropic" {
		t.Errorf("Provider = %q, want %q", haiku.Provider, "anthropic")
	}
	if haiku.InputPrice != 1.0 {
		t.Errorf("InputPrice = %v, want 1.0", haiku.InputPrice)
	}
	if haiku.OutputPrice != 5.0 {
		t.Errorf("OutputPrice = %v, want 5.0", haiku.OutputPrice)
	}
	if haiku.Currency != "USD" {
		t.Errorf("Currency = %q, want %q", haiku.Currency, "USD")
	}
	if haiku.Source != "fetched" {
		t.Errorf("Source = %q, want %q", haiku.Source, "fetched")
	}
	if haiku.FetchedAt != "2026-07-02T15:53:23Z" {
		t.Errorf("FetchedAt = %q, want %q", haiku.FetchedAt, "2026-07-02T15:53:23Z")
	}

	sonnet, ok := table.Price("claude-sonnet")
	if !ok {
		t.Fatalf("expected claude-sonnet to be present")
	}
	if sonnet.InputPrice != 3.0 || sonnet.OutputPrice != 15.0 {
		t.Errorf("sonnet prices = (%v, %v), want (3.0, 15.0)", sonnet.InputPrice, sonnet.OutputPrice)
	}
}

func TestLoadPricingTable_MissingFile(t *testing.T) {
	_, err := LoadPricingTable("/nonexistent/path/pricing.yaml")
	if err == nil {
		t.Fatal("expected error for missing file, got nil")
	}
}

func TestLoadPricingTable_EmptyFile(t *testing.T) {
	path := writeTestPricingFile(t, "")

	_, err := LoadPricingTable(path)
	if err == nil {
		t.Fatal("expected error for empty pricing file, got nil")
	}
}

func TestLoadPricingTable_NullYAMLContent(t *testing.T) {
	path := writeTestPricingFile(t, "null\n")

	_, err := LoadPricingTable(path)
	if err == nil {
		t.Fatal("expected error for pricing file containing YAML null, got nil")
	}
}

func TestPricingTable_PriceNotFound(t *testing.T) {
	path := writeTestPricingFile(t, testPricingYAML)
	table, err := LoadPricingTable(path)
	if err != nil {
		t.Fatalf("LoadPricingTable returned error: %v", err)
	}

	_, ok := table.Price("does-not-exist")
	if ok {
		t.Fatal("expected Price to report not-found for unknown model")
	}
}

func TestCostRatioIn(t *testing.T) {
	path := writeTestPricingFile(t, testPricingYAML)
	table, err := LoadPricingTable(path)
	if err != nil {
		t.Fatalf("LoadPricingTable returned error: %v", err)
	}

	pool := []string{"claude-haiku", "claude-sonnet", "claude-opus"}

	ratio, err := table.CostRatioIn("claude-opus", pool)
	if err != nil {
		t.Fatalf("CostRatioIn(opus) returned error: %v", err)
	}
	if ratio != 1.0 {
		t.Errorf("CostRatioIn(opus) = %v, want 1.0", ratio)
	}

	ratio, err = table.CostRatioIn("claude-haiku", pool)
	if err != nil {
		t.Fatalf("CostRatioIn(haiku) returned error: %v", err)
	}
	if ratio != 5.0 {
		t.Errorf("CostRatioIn(haiku) = %v, want 5.0 (expensive/cheap = 5/1)", ratio)
	}

	ratio, err = table.CostRatioIn("claude-sonnet", pool)
	if err != nil {
		t.Fatalf("CostRatioIn(sonnet) returned error: %v", err)
	}
	wantSonnetRatio := 5.0 / 3.0
	if ratio != wantSonnetRatio {
		t.Errorf("CostRatioIn(sonnet) = %v, want %v", ratio, wantSonnetRatio)
	}
}

func TestCostRatioOut(t *testing.T) {
	path := writeTestPricingFile(t, testPricingYAML)
	table, err := LoadPricingTable(path)
	if err != nil {
		t.Fatalf("LoadPricingTable returned error: %v", err)
	}

	pool := []string{"claude-haiku", "claude-sonnet", "claude-opus"}

	ratio, err := table.CostRatioOut("claude-opus", pool)
	if err != nil {
		t.Fatalf("CostRatioOut(opus) returned error: %v", err)
	}
	if ratio != 1.0 {
		t.Errorf("CostRatioOut(opus) = %v, want 1.0", ratio)
	}

	ratio, err = table.CostRatioOut("claude-haiku", pool)
	if err != nil {
		t.Fatalf("CostRatioOut(haiku) returned error: %v", err)
	}
	if ratio != 5.0 {
		t.Errorf("CostRatioOut(haiku) = %v, want 5.0 (25/5)", ratio)
	}
}

func TestCostRatioIn_ModelNotInTable(t *testing.T) {
	path := writeTestPricingFile(t, testPricingYAML)
	table, err := LoadPricingTable(path)
	if err != nil {
		t.Fatalf("LoadPricingTable returned error: %v", err)
	}

	pool := []string{"claude-haiku", "claude-sonnet"}
	_, err = table.CostRatioIn("does-not-exist", pool)
	if err == nil {
		t.Fatal("expected error for model not in table, got nil")
	}
}

func TestCostRatioIn_PoolMemberNotInTable(t *testing.T) {
	path := writeTestPricingFile(t, testPricingYAML)
	table, err := LoadPricingTable(path)
	if err != nil {
		t.Fatalf("LoadPricingTable returned error: %v", err)
	}

	pool := []string{"claude-haiku", "unknown-model"}
	_, err = table.CostRatioIn("claude-haiku", pool)
	if err == nil {
		t.Fatal("expected error when pool contains unknown model, got nil")
	}
}

func TestCostRatioIn_EmptyPool(t *testing.T) {
	path := writeTestPricingFile(t, testPricingYAML)
	table, err := LoadPricingTable(path)
	if err != nil {
		t.Fatalf("LoadPricingTable returned error: %v", err)
	}

	_, err = table.CostRatioIn("claude-haiku", nil)
	if err == nil {
		t.Fatal("expected error for empty pool, got nil")
	}
}

func TestCostRatioIn_ZeroPriceModel(t *testing.T) {
	yamlContents := `
- provider: test
  model: free-model
  input_price: 0
  output_price: 0
  currency: USD
  source_url: https://example.com
  source: fetched
  fetched_at: '2026-07-02T15:53:23Z'
- provider: test
  model: paid-model
  input_price: 2.0
  output_price: 10.0
  currency: USD
  source_url: https://example.com
  source: fetched
  fetched_at: '2026-07-02T15:53:23Z'
`
	path := writeTestPricingFile(t, yamlContents)
	table, err := LoadPricingTable(path)
	if err != nil {
		t.Fatalf("LoadPricingTable returned error: %v", err)
	}

	pool := []string{"free-model", "paid-model"}
	_, err = table.CostRatioIn("free-model", pool)
	if err == nil {
		t.Fatal("expected error for zero input price (division by zero guard), got nil")
	}

	_, err = table.CostRatioOut("free-model", pool)
	if err == nil {
		t.Fatal("expected error for zero output price (division by zero guard), got nil")
	}
}
