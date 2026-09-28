package pricing

import (
	"context"
	"fmt"
	"sync"
	"time"

	"github.com/regolo-ai/brick-SR1/apps/router/src/spatial-router/pkg/economics"
	"github.com/regolo-ai/brick-SR1/apps/router/src/spatial-router/pkg/observability/logging"
)

const CacheTTL = 1 * time.Hour

type Refresher struct {
	mu         sync.RWMutex
	table      *economics.PricingTable
	lastUpdate time.Time
	token      string
}

func NewRefresher(token string) *Refresher {
	return &Refresher{token: token}
}

func (r *Refresher) Table() *economics.PricingTable {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return r.table
}

func (r *Refresher) SetTable(table *economics.PricingTable) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.table = table
	r.lastUpdate = time.Now()
}

func (r *Refresher) LastUpdate() time.Time {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return r.lastUpdate
}

func (r *Refresher) CacheAge() time.Duration {
	r.mu.RLock()
	defer r.mu.RUnlock()
	if r.lastUpdate.IsZero() {
		return CacheTTL + 1
	}
	return time.Since(r.lastUpdate)
}

func (r *Refresher) GetTokenFromEnv() string {
	return r.token
}

func (r *Refresher) Refresh(ctx context.Context) error {
	token := r.token
	if token == "" {
		token = r.GetTokenFromEnv()
	}

	prices, err := FetchOpenRouterPricesContext(ctx, token)
	if err != nil {
		return fmt.Errorf("pricing: OpenRouter fetch failed: %w", err)
	}

	entries := make([]economics.PriceEntry, 0, len(prices))
	for model, price := range prices {
		entries = append(entries, economics.PriceEntry{
			Model:       model,
			InputPrice:  price.InputPrice,
			OutputPrice: price.OutputPrice,
			Currency:    "USD",
		})
	}

	for model, price := range GetRegoloPrices() {
		entries = append(entries, economics.PriceEntry{
			Model:       model,
			InputPrice:  price.InputPrice,
			OutputPrice: price.OutputPrice,
			Currency:    "EUR",
		})
	}

	r.SetTable(economics.NewPricingTable(entries))

	logging.Infof("pricing: refreshed %d models", len(entries))
	return nil
}

func (r *Refresher) Start(ctx context.Context) {
	if err := r.Refresh(ctx); err != nil {
		logging.Warnf("pricing: initial refresh failed: %v", err)
	} else {
		logging.Infof("pricing: initial refresh completed")
	}

	ticker := time.NewTicker(CacheTTL)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			logging.Infof("pricing: refresher stopped")
			return
		case <-ticker.C:
			if err := r.Refresh(ctx); err != nil {
				logging.Warnf("pricing: hourly refresh failed: %v", err)
			} else {
				logging.Infof("pricing: hourly refresh completed")
			}
		}
	}
}
