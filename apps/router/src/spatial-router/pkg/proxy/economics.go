package proxy

import (
	"net/http"
	"sort"

	"github.com/regolo-ai/brick-SR1/apps/router/src/spatial-router/pkg/economics"
)

// economicsModelStats is the per-model row in the /api/v1/economics response.
type economicsModelStats struct {
	Model              string  `json:"model"`
	Requests           int64   `json:"requests"`
	InputTokens        int64   `json:"input_tokens"`
	OutputTokens       int64   `json:"output_tokens"`
	CostRatioIn        float64 `json:"cost_ratio_in"`
	CostRatioOut       float64 `json:"cost_ratio_out"`
	EstimatedCostUnits float64 `json:"estimated_cost_units"`
}

// economicsResponse is the full body returned by GET /api/v1/economics.
type economicsResponse struct {
	Models             []economicsModelStats `json:"models"`
	MostExpensiveModel string                `json:"most_expensive_model"`
	ActualCostUnits    float64               `json:"actual_cost_units"`
	BaselineCostUnits  float64               `json:"baseline_cost_units_all_expensive"`
	SavingsPct         float64               `json:"savings_pct"`
	PricingAvailable   bool                  `json:"pricing_available"`
	Note               string                `json:"note,omitempty"`
}

// handleEconomics reports real token usage per model, plus the "true"
// savings Brick achieved versus a baseline where every request had been
// sent to the most expensive model in the observed pool. GET-only.
//
// This is intentionally tolerant of missing data: no pricing.yaml, no
// observed traffic, or observed models absent from the pricing table all
// produce a 200 response with as much information as can be computed,
// rather than an error, since this endpoint is meant to be safely pollable
// by the CLI at any point in the router's lifecycle.
func (s *Server) handleEconomics(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}

	store := s.EconomicsStore()
	if store == nil {
		writeJSON(w, http.StatusOK, economicsResponse{})
		return
	}

	snap := store.Snapshot()

	table, err := economics.LoadPricingTable(s.pricingPath)
	if err != nil {
		writeJSON(w, http.StatusOK, economicsResponseTokensOnly(snap, false,
			"pricing table not available; token counts only (run scripts/fetch_pricing.py)"))
		return
	}

	// The pool is every observed model that also has a price entry; cost
	// ratios and the all-expensive baseline are only meaningful within this
	// pool, since models with unknown price would otherwise break the max()
	// used by CostRatioIn/CostRatioOut.
	//
	// Multiple provider pools (e.g. Regolo in EUR alongside the Anthropic
	// passthrough in USD) can be active on the same router and share this
	// one economicsStore. Comparing costs across currencies with a single
	// max()/ratio would be numerically meaningless (a mixed EUR/USD "most
	// expensive" has no real meaning), so the pool is further restricted to
	// whichever currency has the most OBSERVED, priced traffic — i.e. the
	// one actually in active use — and models in any other currency are
	// reported with token counts only (same as "unpriced"), never mixed
	// into the cost computation.
	pricedByModel := make(map[string]economics.PriceEntry, len(snap))
	requestsByCurrency := make(map[string]int64)
	for _, u := range snap {
		if entry, ok := table.Price(u.Model); ok {
			pricedByModel[u.Model] = entry
			requestsByCurrency[entry.Currency] += u.Requests
		}
	}

	dominantCurrency := ""
	var dominantRequests int64 = -1
	for currency, reqs := range requestsByCurrency {
		if reqs > dominantRequests {
			dominantCurrency = currency
			dominantRequests = reqs
		}
	}

	var pool []string
	for _, u := range snap {
		if entry, ok := pricedByModel[u.Model]; ok && entry.Currency == dominantCurrency {
			pool = append(pool, u.Model)
		}
	}

	if len(pool) == 0 {
		writeJSON(w, http.StatusOK, economicsResponseTokensOnly(snap, true,
			"no observed model has pricing data"))
		return
	}

	inPool := make(map[string]bool, len(pool))
	for _, m := range pool {
		inPool[m] = true
	}

	var (
		models            []economicsModelStats
		actualCostUnits   float64
		baselineCostUnits float64
		mostExpensive     string
	)

	for _, u := range snap {
		row := economicsModelStats{
			Model:        u.Model,
			Requests:     u.Requests,
			InputTokens:  u.InputTokens,
			OutputTokens: u.OutputTokens,
		}

		if inPool[u.Model] {
			ratioIn, errIn := table.CostRatioIn(u.Model, pool)
			ratioOut, errOut := table.CostRatioOut(u.Model, pool)
			if errIn == nil && errOut == nil && ratioIn > 0 && ratioOut > 0 {
				row.CostRatioIn = ratioIn
				row.CostRatioOut = ratioOut
				row.EstimatedCostUnits = float64(u.InputTokens)/ratioIn + float64(u.OutputTokens)/ratioOut
			}
			// ratioIn == 1.0 means this model's input price equals the max
			// in the pool, i.e. it IS the most expensive model (by input
			// price, chosen as the reference axis for determinism when
			// input/output prices don't rank models identically).
			if row.CostRatioIn == 1.0 {
				mostExpensive = u.Model
			}

			actualCostUnits += row.EstimatedCostUnits
			baselineCostUnits += float64(u.InputTokens + u.OutputTokens)
		}

		models = append(models, row)
	}

	sort.Slice(models, func(i, j int) bool { return models[i].Model < models[j].Model })

	var savingsPct float64
	if baselineCostUnits > 0 {
		savingsPct = (1 - actualCostUnits/baselineCostUnits) * 100
	}

	note := ""
	if len(requestsByCurrency) > 1 {
		note = "multiple pricing currencies observed (" + dominantCurrency +
			" chosen by traffic volume); models priced in other currencies are shown with token counts only"
	}

	writeJSON(w, http.StatusOK, economicsResponse{
		Models:             models,
		MostExpensiveModel: mostExpensive,
		ActualCostUnits:    actualCostUnits,
		BaselineCostUnits:  baselineCostUnits,
		SavingsPct:         savingsPct,
		PricingAvailable:   true,
		Note:               note,
	})
}

// economicsResponseTokensOnly builds a response containing only the token
// sums from snap, with all cost/ratio fields zeroed, for the "no pricing
// data available" cases (missing pricing.yaml, or no overlap between
// observed models and the pricing table).
func economicsResponseTokensOnly(snap []economics.ModelUsage, pricingAvailable bool, note string) economicsResponse {
	models := make([]economicsModelStats, 0, len(snap))
	for _, u := range snap {
		models = append(models, economicsModelStats{
			Model:        u.Model,
			Requests:     u.Requests,
			InputTokens:  u.InputTokens,
			OutputTokens: u.OutputTokens,
		})
	}
	sort.Slice(models, func(i, j int) bool { return models[i].Model < models[j].Model })

	return economicsResponse{
		Models:           models,
		PricingAvailable: pricingAvailable,
		Note:             note,
	}
}
