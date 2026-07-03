package proxy

import (
	"encoding/json"
	"math"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/regolo-ai/brick-SR1/apps/router/src/spatial-router/pkg/economics"
)

const testPricingYAML = `
- provider: test
  model: cheap
  input_price: 1
  output_price: 5
  currency: USD
- provider: test
  model: expensive
  input_price: 5
  output_price: 25
  currency: USD
`

func writeTestPricingFile(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	path := filepath.Join(dir, "pricing.yaml")
	if err := writeFile(path, testPricingYAML); err != nil {
		t.Fatalf("failed to write test pricing file: %v", err)
	}
	return path
}

// writeFile is a tiny os.WriteFile wrapper kept local to the test file so
// the test doesn't need an extra top-level import alias.
func writeFile(path, contents string) error {
	return os.WriteFile(path, []byte(contents), 0o644)
}

func decodeEconomicsResponse(t *testing.T, rec *httptest.ResponseRecorder) economicsResponse {
	t.Helper()
	var resp economicsResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("failed to decode response body %q: %v", rec.Body.String(), err)
	}
	return resp
}

func approxEqual(a, b, tolerance float64) bool {
	return math.Abs(a-b) <= tolerance
}

// TestHandleEconomicsMethodNotAllowed verifies non-GET requests are rejected.
func TestHandleEconomicsMethodNotAllowed(t *testing.T) {
	srv := &Server{economicsStore: economics.NewStore()}

	rec := httptest.NewRecorder()
	srv.handleEconomics(rec, httptest.NewRequest(http.MethodPost, "/api/v1/economics", nil))
	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("POST should be 405, got %d", rec.Code)
	}
}

// TestHandleEconomicsComputesSavings verifies the core cost-ratio/savings
// math against hand-computed values:
//
//	cheap:      input_price=1, output_price=5,  usage: 1000 in / 1000 out
//	expensive:  input_price=5, output_price=25, usage: 100 in / 100 out
//	unpriced:   no pricing.yaml entry,           usage: 50 in / 50 out
//
// Within the {cheap, expensive} pool, expensive is the most expensive model
// (ratio 1.0 on both axes). cheap's ratio is 5.0 on both axes (5/1 and
// 25/5). Estimated cost units:
//
//	cheap:      1000/5 + 1000/5 = 400
//	expensive:  100/1  + 100/1  = 200
//	actual   = 600
//	baseline = (1000+1000) + (100+100) = 2200   (unpriced model excluded)
//	savings  = (1 - 600/2200) * 100 = 72.7272...%
func TestHandleEconomicsComputesSavings(t *testing.T) {
	store := economics.NewStore()
	store.RecordUsage("cheap", 1000, 1000)
	store.RecordUsage("expensive", 100, 100)
	store.RecordUsage("unpriced", 50, 50)

	srv := &Server{
		economicsStore: store,
		pricingPath:    writeTestPricingFile(t),
	}

	rec := httptest.NewRecorder()
	srv.handleEconomics(rec, httptest.NewRequest(http.MethodGet, "/api/v1/economics", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}

	resp := decodeEconomicsResponse(t, rec)

	if !resp.PricingAvailable {
		t.Fatalf("expected pricing_available=true, got false (note=%q)", resp.Note)
	}
	if resp.MostExpensiveModel != "expensive" {
		t.Fatalf("expected most_expensive_model=expensive, got %q", resp.MostExpensiveModel)
	}
	if len(resp.Models) != 3 {
		t.Fatalf("expected 3 model rows, got %d: %+v", len(resp.Models), resp.Models)
	}

	byModel := make(map[string]economicsModelStats, len(resp.Models))
	for _, m := range resp.Models {
		byModel[m.Model] = m
	}

	cheap, ok := byModel["cheap"]
	if !ok {
		t.Fatalf("missing cheap row in %+v", resp.Models)
	}
	if cheap.InputTokens != 1000 || cheap.OutputTokens != 1000 || cheap.Requests != 1 {
		t.Fatalf("cheap token sums wrong: %+v", cheap)
	}
	if !approxEqual(cheap.CostRatioIn, 5.0, 1e-9) || !approxEqual(cheap.CostRatioOut, 5.0, 1e-9) {
		t.Fatalf("cheap cost ratios wrong: in=%v out=%v", cheap.CostRatioIn, cheap.CostRatioOut)
	}
	if !approxEqual(cheap.EstimatedCostUnits, 400.0, 1e-6) {
		t.Fatalf("cheap estimated cost units wrong: got %v want 400", cheap.EstimatedCostUnits)
	}

	expensive, ok := byModel["expensive"]
	if !ok {
		t.Fatalf("missing expensive row in %+v", resp.Models)
	}
	if !approxEqual(expensive.CostRatioIn, 1.0, 1e-9) || !approxEqual(expensive.CostRatioOut, 1.0, 1e-9) {
		t.Fatalf("expensive cost ratios wrong: in=%v out=%v", expensive.CostRatioIn, expensive.CostRatioOut)
	}
	if !approxEqual(expensive.EstimatedCostUnits, 200.0, 1e-6) {
		t.Fatalf("expensive estimated cost units wrong: got %v want 200", expensive.EstimatedCostUnits)
	}

	unpriced, ok := byModel["unpriced"]
	if !ok {
		t.Fatalf("missing unpriced row in %+v", resp.Models)
	}
	if unpriced.InputTokens != 50 || unpriced.OutputTokens != 50 {
		t.Fatalf("unpriced token sums wrong: %+v", unpriced)
	}
	if unpriced.CostRatioIn != 0 || unpriced.CostRatioOut != 0 || unpriced.EstimatedCostUnits != 0 {
		t.Fatalf("unpriced model should have zeroed cost fields: %+v", unpriced)
	}

	if !approxEqual(resp.ActualCostUnits, 600.0, 1e-6) {
		t.Fatalf("actual_cost_units wrong: got %v want 600", resp.ActualCostUnits)
	}
	if !approxEqual(resp.BaselineCostUnits, 2200.0, 1e-6) {
		t.Fatalf("baseline_cost_units wrong: got %v want 2200", resp.BaselineCostUnits)
	}

	wantSavings := (1 - 600.0/2200.0) * 100
	if !approxEqual(resp.SavingsPct, wantSavings, 1e-6) {
		t.Fatalf("savings_pct wrong: got %v want %v", resp.SavingsPct, wantSavings)
	}
}

// TestHandleEconomicsCacheAwareCost verifies prompt-cache tokens are surfaced
// per model and weighted into cost by the Anthropic multipliers (writes 1.25x,
// reads 0.1x the base input price), on both actual and baseline sides.
//
//	effectiveInput = 1000 + 1.25*400 + 0.1*10000 = 2500
//	cheap:    2500/5 + 1000/5 = 700    (ratios 5.0 as in the plain test)
//	baseline = 2500 + 1000 = 3500
//	savings  = (1 - 700/3500) * 100 = 80%
func TestHandleEconomicsCacheAwareCost(t *testing.T) {
	store := economics.NewStore()
	store.RecordCachedUsage("cheap", 1000, 400, 10000, 1000)
	store.RecordUsage("expensive", 0, 0) // never recorded (all-zero); keep pool via a real call
	store.RecordUsage("expensive", 1, 1)

	srv := &Server{
		economicsStore: store,
		pricingPath:    writeTestPricingFile(t),
	}

	rec := httptest.NewRecorder()
	srv.handleEconomics(rec, httptest.NewRequest(http.MethodGet, "/api/v1/economics", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	resp := decodeEconomicsResponse(t, rec)

	byModel := make(map[string]economicsModelStats, len(resp.Models))
	for _, m := range resp.Models {
		byModel[m.Model] = m
	}
	cheap := byModel["cheap"]
	if cheap.CacheCreationInputTokens != 400 || cheap.CacheReadInputTokens != 10000 {
		t.Fatalf("cache token sums wrong: %+v", cheap)
	}
	if !approxEqual(cheap.EstimatedCostUnits, 700.0, 1e-6) {
		t.Fatalf("cache-aware cost units wrong: got %v want 700", cheap.EstimatedCostUnits)
	}
	// expensive contributes 2 units to both sides; fold it into the check.
	wantSavings := (1 - (700.0+2.0)/(3500.0+2.0)) * 100
	if !approxEqual(resp.SavingsPct, wantSavings, 1e-6) {
		t.Fatalf("savings_pct wrong: got %v want %v", resp.SavingsPct, wantSavings)
	}
}

// TestHandleEconomicsMissingPricingFile verifies the endpoint stays usable
// (200, token counts only) when pricing.yaml is absent.
func TestHandleEconomicsMissingPricingFile(t *testing.T) {
	store := economics.NewStore()
	store.RecordUsage("cheap", 10, 20)

	srv := &Server{
		economicsStore: store,
		pricingPath:    filepath.Join(t.TempDir(), "does-not-exist.yaml"),
	}

	rec := httptest.NewRecorder()
	srv.handleEconomics(rec, httptest.NewRequest(http.MethodGet, "/api/v1/economics", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}

	resp := decodeEconomicsResponse(t, rec)
	if resp.PricingAvailable {
		t.Fatalf("expected pricing_available=false")
	}
	if resp.Note == "" {
		t.Fatalf("expected a non-empty note explaining missing pricing data")
	}
	if len(resp.Models) != 1 || resp.Models[0].Model != "cheap" {
		t.Fatalf("expected token-only row for cheap, got %+v", resp.Models)
	}
	if resp.Models[0].InputTokens != 10 || resp.Models[0].OutputTokens != 20 {
		t.Fatalf("token sums wrong: %+v", resp.Models[0])
	}
	if resp.SavingsPct != 0 {
		t.Fatalf("expected savings_pct=0 without pricing, got %v", resp.SavingsPct)
	}
}

// TestHandleEconomicsEmptyStore verifies an empty store produces a clean
// 200 response with no models and no panics.
func TestHandleEconomicsEmptyStore(t *testing.T) {
	srv := &Server{
		economicsStore: economics.NewStore(),
		pricingPath:    writeTestPricingFile(t),
	}

	rec := httptest.NewRecorder()
	srv.handleEconomics(rec, httptest.NewRequest(http.MethodGet, "/api/v1/economics", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}

	resp := decodeEconomicsResponse(t, rec)
	if len(resp.Models) != 0 {
		t.Fatalf("expected no models, got %+v", resp.Models)
	}
	if resp.SavingsPct != 0 {
		t.Fatalf("expected savings_pct=0, got %v", resp.SavingsPct)
	}
}

// TestHandleEconomicsNilStore verifies the defensive nil-store branch (should
// never happen after NewServer wiring, but must not panic if it does).
func TestHandleEconomicsNilStore(t *testing.T) {
	srv := &Server{}

	rec := httptest.NewRecorder()
	srv.handleEconomics(rec, httptest.NewRequest(http.MethodGet, "/api/v1/economics", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}

	resp := decodeEconomicsResponse(t, rec)
	if len(resp.Models) != 0 {
		t.Fatalf("expected no models, got %+v", resp.Models)
	}
}

// TestHandleEconomicsMixedCurrencyRestrictsPoolToDominant verifies that when
// two provider pools with different currencies are both observed (e.g.
// Anthropic passthrough in USD alongside a Regolo pool in EUR sharing one
// economicsStore), the cost-ratio pool is restricted to whichever currency
// has the most observed, priced requests, and models priced in the other
// currency are still listed (full traffic visibility) with zeroed cost
// fields rather than being silently dropped or mixed into a meaningless
// cross-currency ratio.
func TestHandleEconomicsMixedCurrencyRestrictsPoolToDominant(t *testing.T) {
	pricingYAML := `
- provider: test
  model: usd-cheap
  input_price: 1
  output_price: 5
  currency: USD
- provider: test
  model: usd-expensive
  input_price: 5
  output_price: 25
  currency: USD
- provider: test
  model: eur-model
  input_price: 1
  output_price: 4
  currency: EUR
`
	dir := t.TempDir()
	path := filepath.Join(dir, "pricing.yaml")
	if err := writeFile(path, pricingYAML); err != nil {
		t.Fatalf("failed to write test pricing file: %v", err)
	}

	store := economics.NewStore()
	// USD side has more requests, so USD must be the dominant currency.
	store.RecordUsage("usd-cheap", 1000, 1000)
	store.RecordUsage("usd-expensive", 100, 100)
	// EUR side is priced but has fewer requests; it must be excluded from
	// the cost-ratio pool entirely, not mixed into a USD/EUR ratio.
	store.RecordUsage("eur-model", 500, 500)

	srv := &Server{economicsStore: store, pricingPath: path}

	rec := httptest.NewRecorder()
	srv.handleEconomics(rec, httptest.NewRequest(http.MethodGet, "/api/v1/economics", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}

	resp := decodeEconomicsResponse(t, rec)
	if len(resp.Models) != 3 {
		t.Fatalf("expected 3 model rows (all observed models, regardless of currency), got %d: %+v", len(resp.Models), resp.Models)
	}

	byModel := make(map[string]economicsModelStats, len(resp.Models))
	for _, m := range resp.Models {
		byModel[m.Model] = m
	}

	usdExpensive, ok := byModel["usd-expensive"]
	if !ok {
		t.Fatalf("missing usd-expensive row in %+v", resp.Models)
	}
	if usdExpensive.CostRatioIn != 1.0 {
		t.Errorf("expected usd-expensive to be the dominant-currency pool's most expensive model, got ratio_in=%v", usdExpensive.CostRatioIn)
	}

	eurModel, ok := byModel["eur-model"]
	if !ok {
		t.Fatalf("missing eur-model row in %+v", resp.Models)
	}
	if eurModel.InputTokens != 500 || eurModel.OutputTokens != 500 {
		t.Fatalf("eur-model token sums wrong (must still be visible even though excluded from cost pool): %+v", eurModel)
	}
	if eurModel.CostRatioIn != 0 || eurModel.CostRatioOut != 0 || eurModel.EstimatedCostUnits != 0 {
		t.Errorf("expected eur-model to be excluded from the dominant (USD) cost pool with zeroed cost fields: %+v", eurModel)
	}

	if resp.MostExpensiveModel != "usd-expensive" {
		t.Errorf("expected most_expensive_model=usd-expensive, got %q", resp.MostExpensiveModel)
	}

	// Baseline/actual must only reflect the USD pool (1000+1000 + 100+100 =
	// 2200), never including the EUR-priced model's tokens.
	if !approxEqual(resp.BaselineCostUnits, 2200.0, 1e-6) {
		t.Errorf("baseline_cost_units should exclude the non-dominant-currency model, got %v want 2200", resp.BaselineCostUnits)
	}

	if resp.Note == "" {
		t.Error("expected a non-empty note explaining the mixed-currency restriction")
	}
}

