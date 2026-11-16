package brickrouting

import (
	"crypto/sha256"
	"encoding/hex"
	"sync"
	"time"
)

const (
	// vectorCacheEntries bounds the memoized capability vectors. Each entry is
	// six float64 values plus a key, so the cache costs a few kilobytes.
	vectorCacheEntries = 64
	vectorCacheTTL     = 10 * time.Minute

	// routingTextLimit bounds the text handed to the classifier. The worker has
	// its own token budget; this only prevents shipping megabytes over the
	// worker pipe, where the tokenizer would walk the whole string anyway.
	routingTextLimit = 8192
)

type cacheEntry struct {
	vector  []float64
	expires time.Time
}

// vectorCache memoizes classifier output for repeated prompts. A capability
// vector depends only on the text, and harnesses resend the same conversation
// view for retries, summaries and titles.
type vectorCache struct {
	mu      sync.Mutex
	entries map[string]cacheEntry
	order   []string
	limit   int
	ttl     time.Duration
	now     func() time.Time
}

func newVectorCache(limit int, ttl time.Duration) *vectorCache {
	return &vectorCache{
		entries: make(map[string]cacheEntry, limit),
		limit:   limit,
		ttl:     ttl,
		now:     time.Now,
	}
}

func (c *vectorCache) get(key string) ([]float64, bool) {
	if c == nil {
		return nil, false
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	entry, ok := c.entries[key]
	if !ok {
		return nil, false
	}
	if !entry.expires.After(c.now()) {
		delete(c.entries, key)
		return nil, false
	}
	return entry.vector, true
}

func (c *vectorCache) put(key string, vector []float64) {
	if c == nil || len(vector) == 0 {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if _, ok := c.entries[key]; !ok {
		c.order = append(c.order, key)
		for len(c.order) > c.limit {
			oldest := c.order[0]
			c.order = c.order[1:]
			delete(c.entries, oldest)
		}
	}
	c.entries[key] = cacheEntry{
		vector:  append([]float64(nil), vector...),
		expires: c.now().Add(c.ttl),
	}
}

func vectorKey(text string) string {
	sum := sha256.Sum256([]byte(text))
	return hex.EncodeToString(sum[:16])
}

type inflightCall struct {
	done   chan struct{}
	vector []float64
	err    error
}

// classifyGroup collapses concurrent classifications of the same text into a
// single inference. The worker handles one request at a time, so duplicate
// prompts would otherwise queue behind each other.
type classifyGroup struct {
	mu    sync.Mutex
	calls map[string]*inflightCall
}

func (g *classifyGroup) do(key string, fn func() ([]float64, error)) ([]float64, error) {
	g.mu.Lock()
	if call, ok := g.calls[key]; ok {
		g.mu.Unlock()
		<-call.done
		return call.vector, call.err
	}
	call := &inflightCall{done: make(chan struct{})}
	if g.calls == nil {
		g.calls = make(map[string]*inflightCall)
	}
	g.calls[key] = call
	g.mu.Unlock()

	call.vector, call.err = fn()

	g.mu.Lock()
	delete(g.calls, key)
	g.mu.Unlock()
	close(call.done)
	return call.vector, call.err
}

// trimRoutingText keeps the tail of the conversation: the latest turns carry
// the intent, and older context is already represented in the classifier's
// token budget.
func trimRoutingText(text string, limit int) string {
	if limit <= 0 || len(text) <= limit {
		return text
	}
	cut := len(text) - limit
	for cut < len(text) && (text[cut]&0xC0) == 0x80 {
		cut++
	}
	return text[cut:]
}
