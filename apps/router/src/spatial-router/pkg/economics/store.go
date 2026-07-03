package economics

import (
	"encoding/json"
	"fmt"
	"os"
	"sort"
	"sync"

	"github.com/regolo-ai/brick-SR1/apps/router/src/spatial-router/pkg/observability/logging"
)

// ModelUsage is the accumulated usage for one model.
//
// InputTokens counts only the non-cached portion of the prompt (Anthropic's
// usage.input_tokens excludes prompt-cache reads/writes, which is why it can
// be tiny next to Claude Code's context meter). Cache reads and writes are
// tracked separately so cost math can weight them by their real price
// multipliers. Older snapshot files without the cache fields load as zeroes.
type ModelUsage struct {
	Model                    string `json:"model"`
	Requests                 int64  `json:"requests"`
	InputTokens              int64  `json:"input_tokens"`
	CacheCreationInputTokens int64  `json:"cache_creation_input_tokens,omitempty"`
	CacheReadInputTokens     int64  `json:"cache_read_input_tokens,omitempty"`
	OutputTokens             int64  `json:"output_tokens"`
}

// Store accumulates per-model token usage in memory and can snapshot to /
// load from a JSON file on disk, so counters survive process restarts.
// Store is safe for concurrent use.
type Store struct {
	mu    sync.Mutex
	usage map[string]ModelUsage
}

// NewStore creates an empty in-memory store.
func NewStore() *Store {
	return &Store{
		usage: make(map[string]ModelUsage),
	}
}

// RecordUsage adds one request's token usage for a model to the running
// totals. Safe to call concurrently. For providers that report prompt-cache
// counters (Anthropic), use RecordCachedUsage instead.
func (s *Store) RecordUsage(model string, inputTokens, outputTokens int64) {
	s.RecordCachedUsage(model, inputTokens, 0, 0, outputTokens)
}

// RecordCachedUsage adds one request's token usage including prompt-cache
// counters (cache_creation_input_tokens / cache_read_input_tokens from the
// Anthropic Messages API) to the running totals. Safe to call concurrently.
func (s *Store) RecordCachedUsage(model string, inputTokens, cacheCreationTokens, cacheReadTokens, outputTokens int64) {
	s.mu.Lock()
	defer s.mu.Unlock()

	entry := s.usage[model]
	entry.Model = model
	entry.Requests++
	entry.InputTokens += inputTokens
	entry.CacheCreationInputTokens += cacheCreationTokens
	entry.CacheReadInputTokens += cacheReadTokens
	entry.OutputTokens += outputTokens
	s.usage[model] = entry
}

// Reset clears all accumulated usage counters in memory. Callers that persist
// snapshots to disk (see Server.saveEconomicsSnapshot) must re-save after
// calling this, otherwise the cleared counters only last until the next
// restart reloads the stale snapshot file.
func (s *Store) Reset() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.usage = make(map[string]ModelUsage)
}

// Snapshot returns a copy of all accumulated usage, one entry per model
// that has received at least one RecordUsage call, sorted by model name
// for deterministic output.
func (s *Store) Snapshot() []ModelUsage {
	s.mu.Lock()
	defer s.mu.Unlock()

	snap := make([]ModelUsage, 0, len(s.usage))
	for _, entry := range s.usage {
		snap = append(snap, entry)
	}
	sort.Slice(snap, func(i, j int) bool {
		return snap[i].Model < snap[j].Model
	})
	return snap
}

// SaveSnapshot writes the current snapshot to path as JSON (pretty-printed,
// 2-space indent). Overwrites any existing file at path.
func (s *Store) SaveSnapshot(path string) error {
	snap := s.Snapshot()

	data, err := json.MarshalIndent(snap, "", "  ")
	if err != nil {
		return fmt.Errorf("economics: failed to marshal usage snapshot: %w", err)
	}

	if err := os.WriteFile(path, data, 0o644); err != nil {
		return fmt.Errorf("economics: failed to write usage snapshot to %q: %w", path, err)
	}

	logging.Debugf("economics: saved usage snapshot to %q (%d models)", path, len(snap))
	return nil
}

// LoadSnapshot reads a JSON snapshot file at path and replaces the store's
// in-memory state with its contents. If path does not exist, this is not
// an error — it's treated as "no prior snapshot" and the store stays empty.
// Any other read/parse error is returned.
func (s *Store) LoadSnapshot(path string) error {
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			logging.Debugf("economics: no prior usage snapshot at %q, starting empty", path)
			return nil
		}
		return fmt.Errorf("economics: failed to read usage snapshot %q: %w", path, err)
	}

	var entries []ModelUsage
	if err := json.Unmarshal(data, &entries); err != nil {
		return fmt.Errorf("economics: failed to parse usage snapshot %q: %w", path, err)
	}

	usage := make(map[string]ModelUsage, len(entries))
	for _, entry := range entries {
		usage[entry.Model] = entry
	}

	s.mu.Lock()
	s.usage = usage
	s.mu.Unlock()

	logging.Infof("economics: loaded usage snapshot from %q (%d models)", path, len(entries))
	return nil
}
