// Package economics loads model pricing data and tracks per-model token
// usage for the spatial router, enabling cost-aware routing decisions and
// usage reporting.
//
// The package has two independent pieces:
//
//   - PricingTable: a read-only table of per-model input/output prices
//     loaded from a pricing.yaml file, with helpers to compute a model's
//     cost ratio relative to the most expensive model in a candidate pool.
//
//   - Store: a thread-safe, in-memory accumulator of per-model request and
//     token counts, with JSON snapshot persistence so counters survive
//     process restarts.
//
// Neither type talks to the HTTP proxy layer directly; callers (in
// pkg/proxy and elsewhere) are responsible for parsing upstream usage data
// and invoking Store.RecordUsage, and for wiring PricingTable into routing
// decisions.
package economics

import (
	"fmt"
	"os"

	"github.com/regolo-ai/brick-SR1/apps/router/src/spatial-router/pkg/observability/logging"
	"gopkg.in/yaml.v3"
)

// PriceEntry is one row loaded from pricing.yaml.
type PriceEntry struct {
	Provider    string  `yaml:"provider"`
	Model       string  `yaml:"model"`
	InputPrice  float64 `yaml:"input_price"`
	OutputPrice float64 `yaml:"output_price"`
	Currency    string  `yaml:"currency"`
	SourceURL   string  `yaml:"source_url"`
	Source      string  `yaml:"source"`
	FetchedAt   string  `yaml:"fetched_at"`
}

// PricingTable holds all loaded price entries, indexed by model name.
type PricingTable struct {
	entries map[string]PriceEntry
}

// LoadPricingTable reads and parses a pricing.yaml file at the given path.
// Returns an error if the file cannot be read or parsed. An empty/missing
// file is a caller error (return the error), not silently tolerated.
func LoadPricingTable(path string) (*PricingTable, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("economics: failed to read pricing file %q: %w", path, err)
	}

	var records []PriceEntry
	if err := yaml.Unmarshal(data, &records); err != nil {
		return nil, fmt.Errorf("economics: failed to parse pricing file %q: %w", path, err)
	}

	if len(records) == 0 {
		return nil, fmt.Errorf("economics: pricing file %q contains no price entries", path)
	}

	entries := make(map[string]PriceEntry, len(records))
	for _, rec := range records {
		entries[rec.Model] = rec
	}

	logging.Infof("economics: loaded pricing table from %q with %d models", path, len(entries))

	return &PricingTable{entries: entries}, nil
}

// Price returns the PriceEntry for a model, and whether it was found.
func (t *PricingTable) Price(model string) (PriceEntry, bool) {
	entry, ok := t.entries[model]
	return entry, ok
}

// CostRatioIn returns most-expensive-input-price-in-pool / this model's
// input price, for the given model within the given pool of model names.
// Returns 0 and an error if the model or any pool member is not in the
// table, or if the model's input price is 0 (division by zero guard).
func (t *PricingTable) CostRatioIn(model string, pool []string) (float64, error) {
	return t.costRatio(model, pool, func(e PriceEntry) float64 { return e.InputPrice }, "input")
}

// CostRatioOut is the same as CostRatioIn but for output price.
func (t *PricingTable) CostRatioOut(model string, pool []string) (float64, error) {
	return t.costRatio(model, pool, func(e PriceEntry) float64 { return e.OutputPrice }, "output")
}

// costRatio computes max(priceOf(m) for m in pool) / priceOf(model), using
// priceOf to select either the input or output price field. priceKind is
// used only for error messages ("input" or "output").
func (t *PricingTable) costRatio(model string, pool []string, priceOf func(PriceEntry) float64, priceKind string) (float64, error) {
	if len(pool) == 0 {
		return 0, fmt.Errorf("economics: cannot compute %s cost ratio for %q: pool is empty", priceKind, model)
	}

	modelEntry, ok := t.entries[model]
	if !ok {
		return 0, fmt.Errorf("economics: cannot compute %s cost ratio: model %q not found in pricing table", priceKind, model)
	}

	modelPrice := priceOf(modelEntry)
	if modelPrice == 0 {
		return 0, fmt.Errorf("economics: cannot compute %s cost ratio for %q: %s price is 0", priceKind, model, priceKind)
	}

	var maxPrice float64
	seenMax := false
	for _, poolModel := range pool {
		entry, ok := t.entries[poolModel]
		if !ok {
			return 0, fmt.Errorf("economics: cannot compute %s cost ratio: pool member %q not found in pricing table", priceKind, poolModel)
		}
		price := priceOf(entry)
		if !seenMax || price > maxPrice {
			maxPrice = price
			seenMax = true
		}
	}

	return maxPrice / modelPrice, nil
}
