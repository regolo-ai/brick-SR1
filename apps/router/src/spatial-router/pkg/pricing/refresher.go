package pricing

import (
	"context"
	"fmt"
	"os"
	"strings"
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
	// Merge fresh entries over the previous table so a failing source
	// degrades to the last known prices instead of wiping them. A pool
	// served entirely from static sources (Regolo map, seeded pricing.yaml)
	// therefore needs no OpenRouter key and never trips the stale-cache
	// shutdown: every refresh succeeds and the timestamp stays fresh.
	merged := make(map[string]economics.PriceEntry)
	if prev := r.Table(); prev != nil {
		for _, e := range prev.Entries() {
			merged[e.Model] = e
		}
	}
	sources := []string{}

	token := r.token
	if token == "" {
		token = os.Getenv("OPENROUTER_API_KEY")
	}
	if token == "" {
		logging.Infof("pricing: no OpenRouter token configured; using static sources only")
	} else if prices, err := FetchOpenRouterPricesContext(ctx, token); err != nil {
		logging.Warnf("pricing: OpenRouter refresh failed, keeping previous entries: %v", err)
	} else {
		for model, price := range prices {
			merged[model] = economics.PriceEntry{
				Model:       model,
				InputPrice:  price.InputPrice,
				OutputPrice: price.OutputPrice,
				Currency:    "USD",
			}
		}
		sources = append(sources, "openrouter")
	}

	for model, price := range GetRegoloPrices() {
		merged[model] = economics.PriceEntry{
			Model:       model,
			InputPrice:  price.InputPrice,
			OutputPrice: price.OutputPrice,
			Currency:    "EUR",
		}
	}
	sources = append(sources, "regolo-static")

	if len(merged) == 0 {
		return fmt.Errorf("pricing: no prices available from any source")
	}

	entries := make([]economics.PriceEntry, 0, len(merged))
	for _, e := range merged {
		entries = append(entries, e)
	}
	r.SetTable(economics.NewPricingTable(entries))

	logging.Infof("pricing: refreshed %d models (%s)", len(entries), strings.Join(sources, "+"))
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
