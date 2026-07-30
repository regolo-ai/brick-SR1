// Package sticky holds per-conversation cache-aware routing state for the
// Anthropic passthrough and OpenAI/Codex Brick paths. It backs "sticky" and
// "smartsqueeze" routing: once a conversation is warm on a model, Brick prefers
// to stay there unless switching is worth the prompt-cache invalidation cost.
package sticky

import (
	"hash/fnv"
	"strconv"
	"sync"
	"time"
)

// Entry is the per-conversation sticky routing state.
type Entry struct {
	// LastModel is the model chosen on the conversation's most recent turn.
	LastModel string
	// LastSeen is the response-arrival time of that turn. Used both for TTL
	// expiry and for last-write-wins ordering under concurrent updates.
	LastSeen time.Time
	// LastContextTokens is input+cache_read+cache_creation of the last response,
	// i.e. the size of the prefix that would have to be reprocessed on a switch.
	LastContextTokens int64
	// Compacted reports whether the last turn was served with smartsqueeze
	// compaction. When true, subsequent same-model turns keep compacting
	// deterministically so the new model's cache stays warm on the reduced prefix
	// (see pkg/compaction and pkg/proxy/anthropic.go). Always false in sticky mode.
	Compacted bool
}

// Store holds per-conversation sticky routing state with a TTL. An entry older
// than the TTL is treated as absent: an expired entry means the upstream prompt
// cache is cold, so switching models costs nothing and routing is unconstrained.
//
// A single mutex guards the map; the volume (one op per turn) does not justify
// per-key locking. Correctness under out-of-order concurrent turns comes from
// arrival-time ordering in Record, not from lock granularity.
type Store struct {
	mu  sync.Mutex
	ttl time.Duration
	m   map[string]Entry
}

// New returns an empty Store with the given entry TTL.
func New(ttl time.Duration) *Store {
	return &Store{ttl: ttl, m: make(map[string]Entry)}
}

// GetAt returns the entry for key if present and not expired at now. Expired
// entries are lazily evicted.
func (s *Store) GetAt(key string, now time.Time) (Entry, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	e, ok := s.m[key]
	if !ok {
		return Entry{}, false
	}
	if now.Sub(e.LastSeen) > s.ttl {
		delete(s.m, key)
		return Entry{}, false
	}
	return e, true
}

// Get is GetAt with the current wall clock.
func (s *Store) Get(key string) (Entry, bool) { return s.GetAt(key, time.Now()) }

// Record stores the model chosen for a conversation turn, ordered by the
// response-arrival timestamp arrivedAt. A write whose arrivedAt is not strictly
// newer than the stored LastSeen is ignored, so an out-of-order or concurrent
// response (parallel tool calls on one conversation) never clobbers fresher
// state with stale numbers. compacted records whether smartsqueeze served a
// compacted body this turn, so the next turn can keep the reduced prefix stable.
func (s *Store) Record(key, model string, contextTokens int64, compacted bool, arrivedAt time.Time) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if e, ok := s.m[key]; ok && !arrivedAt.After(e.LastSeen) {
		return
	}
	s.m[key] = Entry{LastModel: model, LastSeen: arrivedAt, LastContextTokens: contextTokens, Compacted: compacted}
}

// Prune removes every entry already expired at now, returning the count
// removed. The predicate is byte-identical to GetAt's lazy-eviction check
// (now.Sub(e.LastSeen) > s.ttl), so Prune only deletes entries that any
// subsequent read would already treat as absent (the no-prev / cold path,
// identical to expired). It exists to bound memory: lazy eviction never fires
// for keys that are never re-read (one-shot conversations such as routed
// subagents), so without a periodic sweep the map grows monotonically. It
// never changes a routing decision.
func (s *Store) Prune(now time.Time) (removed int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for k, e := range s.m {
		if now.Sub(e.LastSeen) > s.ttl {
			delete(s.m, k)
			removed++
		}
	}
	return removed
}

// Len returns the number of live entries (after any lazy eviction performed by
// prior GetAt calls). Intended for tests and diagnostics.
func (s *Store) Len() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.m)
}

// HashIdentity derives a stable conversation key from the parts of the prompt
// that stay constant across turns: the system prompt and the first user turn.
// A nul separator prevents collisions between adjacent fields.
//
// Known fragility (logged as identity_miss by the handler, not fixed here): if
// the client rewrites the system prompt or first turn mid-conversation (e.g. its
// own summarization/compaction), the hash changes and the conversation restarts
// cold in the store.
func HashIdentity(system, firstUser string) string {
	h := fnv.New64a()
	_, _ = h.Write([]byte(system))
	_, _ = h.Write([]byte{0})
	_, _ = h.Write([]byte(firstUser))
	return strconv.FormatUint(h.Sum64(), 16)
}
