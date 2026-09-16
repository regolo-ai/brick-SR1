package proxy

import (
	"net/http"
	"sort"

	"github.com/regolo-ai/brick-SR1/apps/router/src/spatial-router/pkg/economics"
)

// Anthropic prompt-cache price multipliers relative to the base input-token
// price: a 5-minute cache write costs 1.25x, a cache read 0.1x. Applied
// identically to the actual cost and the all-expensive baseline (same cache
// behaviour assumed on the baseline model), so savings_pct stays a pure
// model-mix comparison while token costs reflect reality.
// https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching
const (
	cacheWriteInputPriceMultiplier = 1.25
	cacheReadInputPriceMultiplier  = 0.10
)

// economicsModelStats is the per-model row in the /api/v1/economics response.
type economicsModelStats struct {
	Model                    string  `json:"model"`
	Requests                 int64   `json:"requests"`
	InputTokens              int64   `json:"input_tokens"`
	CacheCreationInputTokens int64   `json:"cache_creation_input_tokens"`
	CacheReadInputTokens     int64   `json:"cache_read_input_tokens"`
	OutputTokens             int64   `json:"output_tokens"`
	CostRatioIn              float64 `json:"cost_ratio_in"`
	CostRatioOut             float64 `json:"cost_ratio_out"`
	EstimatedCostUnits       float64 `json:"estimated_cost_units"`
}

// economicsResponse is the full body returned by GET /api/v1/economics.
type economicsResponse struct {
	Models             []economicsModelStats `json:"models"`
	MostExpensiveModel string                `json:"most_expensive_model"`
	ActualCostUnits    float64               `json:"actual_cost_units"`
	BaselineCostUnits  float64               `json:"baseline_cost_units_all_expensive"`
	SavingsPct         float64               `json:"savings_pct"`
	// SavingsPctVsOpus is a second, opus-anchored baseline: the savings Brick
	// achieved versus sending every priced request to claude-opus, regardless
	// of which model is the most expensive one actually observed. It exists so
	// the CLI can always show a "vs opus" figure even when a pricier model
	// (e.g. Fable) dominates the most-expensive baseline above. Nil (omitted)
	// when opus is not resolvable in the pricing table for the active pool, so
	// a missing baseline is never rendered as a misleading 0%.
	SavingsPctVsOpus *float64 `json:"savings_pct_vs_opus,omitempty"`
	BaselineModel    string   `json:"baseline_model,omitempty"`
	PricingAvailable bool     `json:"pricing_available"`
	Note             string   `json:"note,omitempty"`
}

// opusBaselineModel is the fixed reference model for the vs-opus savings
// baseline. Prefix-matched against pricing.yaml (so "claude-opus-4-8" resolves
// to the "claude-opus" entry), mirroring PricingTable.Price semantics.
const opusBaselineModel = "claude-opus"

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

	baselineModel := r.URL.Query().Get("baseline_model")
	store := s.EconomicsStore()
	if store == nil {
		resp := economicsResponse{}
		if baselineModel != "" {
			resp.BaselineModel = baselineModel
			resp.Note = "economics store not available; token counts unavailable"
		}
		writeJSON(w, http.StatusOK, resp)
		return
	}

	snap := store.Snapshot()

	table, err := economics.LoadPricingTable(s.pricingPath)
	if err != nil {
		resp := economicsResponseTokensOnly(snap, false,
			"pricing table not available; token counts only (run scripts/fetch_pricing.py)")
		resp.BaselineModel = baselineModel
		writeJSON(w, http.StatusOK, resp)
		return
	}

	// An explicit baseline is an absolute provider-price comparison and may be
	// a model that has never appeared in observed traffic (Codex uses all-Sol).
	if baselineModel != "" {
		writeJSON(w, http.StatusOK, economicsResponseForBaseline(snap, table, baselineModel))
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

	// Resolve opus's absolute price once (nil if the dominant-currency pool
	// has no opus entry). The vs-opus baseline is computed from ABSOLUTE
	// prices rather than the pool-relative cost ratios used for savings_pct,
	// since opus may not be the most expensive model in the pool (Fable is
	// pricier) and the pool-normalised units cancel against the wrong anchor.
	opusEntry, opusPriced := table.Price(opusBaselineModel)
	if opusPriced && opusEntry.Currency != dominantCurrency {
		// An opus entry priced in a non-dominant currency cannot be compared
		// with the dominant-currency traffic; treat as unavailable.
		opusPriced = false
	}

	var (
		models              []economicsModelStats
		actualCostUnits     float64
		baselineCostUnits   float64
		mostExpensive       string
		actualAbsoluteCost  float64 // sum over pool of real per-model $ cost
		opusBaselineAbsCost float64 // same traffic, all priced at opus rates
	)

	for _, u := range snap {
		row := economicsModelStats{
			Model:                    u.Model,
			Requests:                 u.Requests,
			InputTokens:              u.InputTokens,
			CacheCreationInputTokens: u.CacheCreationInputTokens,
			CacheReadInputTokens:     u.CacheReadInputTokens,
			OutputTokens:             u.OutputTokens,
		}

		// Effective input tokens: cache writes/reads weighted by their price
		// multipliers so a mostly-cached 200k context is billed as ~20k-worth
		// of base-price input, matching real Anthropic invoicing.
		effectiveInput := float64(u.InputTokens) +
			cacheWriteInputPriceMultiplier*float64(u.CacheCreationInputTokens) +
			cacheReadInputPriceMultiplier*float64(u.CacheReadInputTokens)

		if inPool[u.Model] {
			ratioIn, errIn := table.CostRatioIn(u.Model, pool)
			ratioOut, errOut := table.CostRatioOut(u.Model, pool)
			if errIn == nil && errOut == nil && ratioIn > 0 && ratioOut > 0 {
				row.CostRatioIn = ratioIn
				row.CostRatioOut = ratioOut
				row.EstimatedCostUnits = effectiveInput/ratioIn + float64(u.OutputTokens)/ratioOut
			}
			// ratioIn == 1.0 means this model's input price equals the max
			// in the pool, i.e. it IS the most expensive model (by input
			// price, chosen as the reference axis for determinism when
			// input/output prices don't rank models identically).
			if row.CostRatioIn == 1.0 {
				mostExpensive = u.Model
			}

			actualCostUnits += row.EstimatedCostUnits
			baselineCostUnits += effectiveInput + float64(u.OutputTokens)

			// Opus-anchored baseline (absolute prices): this model's real cost
			// vs the same tokens billed entirely at opus rates.
			if opusPriced {
				if entry, ok := pricedByModel[u.Model]; ok {
					actualAbsoluteCost += effectiveInput*entry.InputPrice + float64(u.OutputTokens)*entry.OutputPrice
					opusBaselineAbsCost += effectiveInput*opusEntry.InputPrice + float64(u.OutputTokens)*opusEntry.OutputPrice
				}
			}
		}

		models = append(models, row)
	}

	sort.Slice(models, func(i, j int) bool { return models[i].Model < models[j].Model })

	var savingsPct float64
	if baselineCostUnits > 0 {
		savingsPct = (1 - actualCostUnits/baselineCostUnits) * 100
	}

	// Opus-anchored savings: only meaningful when opus is priced in the
	// dominant currency and there was real priced traffic to compare. Left
	// nil (omitted from JSON) otherwise, so the CLI never shows a fake 0%.
	var savingsPctVsOpus *float64
	if opusPriced && opusBaselineAbsCost > 0 {
		v := (1 - actualAbsoluteCost/opusBaselineAbsCost) * 100
		savingsPctVsOpus = &v
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
		SavingsPctVsOpus:   savingsPctVsOpus,
		PricingAvailable:   true,
		Note:               note,
	})
}

func cachedInputPrice(entry economics.PriceEntry) float64 {
	if entry.CachedInputPrice > 0 {
		return entry.CachedInputPrice
	}
	return entry.InputPrice * cacheReadInputPriceMultiplier
}

// economicsResponseForBaseline compares all observed traffic with the same
// fresh/cache/output tokens billed at one explicitly requested model. It does
// not use the observed-model pool, so an unobserved Sol remains a valid anchor.
func economicsResponseForBaseline(snap []economics.ModelUsage, table *economics.PricingTable, baselineModel string) economicsResponse {
	baseline, ok := table.Price(baselineModel)
	if !ok || baseline.InputPrice <= 0 || baseline.OutputPrice <= 0 {
		resp := economicsResponseTokensOnly(snap, false,
			"baseline model "+baselineModel+" has no pricing data; token counts only")
		resp.BaselineModel = baselineModel
		return resp
	}

	models := make([]economicsModelStats, 0, len(snap))
	var actual, baselineCost float64
	for _, u := range snap {
		row := economicsModelStats{
			Model: u.Model, Requests: u.Requests, InputTokens: u.InputTokens,
			CacheCreationInputTokens: u.CacheCreationInputTokens,
			CacheReadInputTokens:     u.CacheReadInputTokens, OutputTokens: u.OutputTokens,
		}
		entry, priced := table.Price(u.Model)
		if !priced || entry.Currency != baseline.Currency || entry.InputPrice <= 0 || entry.OutputPrice <= 0 {
			models = append(models, row)
			continue
		}
		row.CostRatioIn = baseline.InputPrice / entry.InputPrice
		row.CostRatioOut = baseline.OutputPrice / entry.OutputPrice
		row.EstimatedCostUnits = float64(u.InputTokens)*entry.InputPrice +
			float64(u.CacheCreationInputTokens)*entry.InputPrice*cacheWriteInputPriceMultiplier +
			float64(u.CacheReadInputTokens)*cachedInputPrice(entry) +
			float64(u.OutputTokens)*entry.OutputPrice
		actual += row.EstimatedCostUnits
		baselineCost += float64(u.InputTokens)*baseline.InputPrice +
			float64(u.CacheCreationInputTokens)*baseline.InputPrice*cacheWriteInputPriceMultiplier +
			float64(u.CacheReadInputTokens)*cachedInputPrice(baseline) +
			float64(u.OutputTokens)*baseline.OutputPrice
		models = append(models, row)
	}
	sort.Slice(models, func(i, j int) bool { return models[i].Model < models[j].Model })

	// A partial comparison would be misleading: preserve every token row but
	// clearly mark pricing unavailable if any observed traffic could not be
	// priced in the baseline currency.
	for _, row := range models {
		if row.Requests > 0 && row.EstimatedCostUnits == 0 &&
			(row.InputTokens != 0 || row.CacheCreationInputTokens != 0 || row.CacheReadInputTokens != 0 || row.OutputTokens != 0) {
			return economicsResponse{
				Models: models, BaselineModel: baselineModel, PricingAvailable: false,
				Note: "one or more observed models have no compatible pricing; token counts retained",
			}
		}
	}

	savings := 0.0
	if baselineCost > 0 {
		savings = (1 - actual/baselineCost) * 100
	}
	return economicsResponse{
		Models: models, MostExpensiveModel: baselineModel, BaselineModel: baselineModel,
		ActualCostUnits: actual, BaselineCostUnits: baselineCost, SavingsPct: savings,
		PricingAvailable: true,
	}
}

// economicsResponseTokensOnly builds a response containing only the token
// sums from snap, with all cost/ratio fields zeroed, for the "no pricing
// data available" cases (missing pricing.yaml, or no overlap between
// observed models and the pricing table).
func economicsResponseTokensOnly(snap []economics.ModelUsage, pricingAvailable bool, note string) economicsResponse {
	models := make([]economicsModelStats, 0, len(snap))
	for _, u := range snap {
		models = append(models, economicsModelStats{
			Model:                    u.Model,
			Requests:                 u.Requests,
			InputTokens:              u.InputTokens,
			CacheCreationInputTokens: u.CacheCreationInputTokens,
			CacheReadInputTokens:     u.CacheReadInputTokens,
			OutputTokens:             u.OutputTokens,
		})
	}
	sort.Slice(models, func(i, j int) bool { return models[i].Model < models[j].Model })

	return economicsResponse{
		Models:           models,
		PricingAvailable: pricingAvailable,
		Note:             note,
	}
}
