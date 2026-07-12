package proxy

import (
	"encoding/json"
	"os"
	"sync"

	"github.com/regolo-ai/brick-SR1/apps/router/src/spatial-router/pkg/observability/logging"
)

// routingEvent is one JSONL record describing a single routed /v1/messages
// request: the router's candidate model, the model actually served, the
// conversation identity, the prompt-cache reprocessing cost a sticky hold
// avoided this turn, and Brick's end-to-end latency. It is written after the
// response has been fully streamed to the client, so it is off the request's
// critical path and never influences what is served.
//
// The offline aggregator (`brick claude stats routing`) reads this log to
// produce the promotion-gate quantities: distinct dev sessions (by SessionKey),
// median realized savings (from EstSwitchDelta on held turns, where
// CandidateModel != ServedModel), and p50/p95 latency per mode. Emitting it in
// every routing mode (off/sticky/orchestrator) gives the comparison a baseline.
type routingEvent struct {
	TS             string  `json:"ts"`
	Mode           string  `json:"mode"`
	SessionKey     string  `json:"session_key,omitempty"`
	CandidateModel string  `json:"candidate_model"`
	ServedModel    string  `json:"served_model"`
	CtxTokens      int64   `json:"ctx_tokens"`
	EstSwitchDelta float64 `json:"est_switch_delta_price_units"`
	// EstSavedTokens is the smartsqueeze compactor's estimate of prefix tokens
	// removed on this turn (0 outside smartsqueeze mode, or when nothing was
	// cleared). Populated in both shadow and served sub-modes so the aggregator
	// can report realized-vs-shadow savings.
	EstSavedTokens int64  `json:"est_saved_tokens,omitempty"`
	E2ELatencyMs   int64  `json:"e2e_latency_ms"`
	ShadowNote     string `json:"shadow_note,omitempty"`
}

// routingEventLogger appends routingEvent records to a JSONL file. Writes are
// serialized by a mutex and are best-effort: a write failure is logged and
// dropped rather than propagated, since routing observability must never break
// request serving. A nil logger (path never opened) makes append a no-op, so
// tests that construct a Server without a data dir are unaffected.
type routingEventLogger struct {
	mu   sync.Mutex
	f    *os.File
	path string
}

// newRoutingEventLogger opens (creating if absent) the append-only JSONL sink
// at path. On failure it returns nil, and callers treat a nil logger as
// disabled: the router still serves, it just records no routing events. The
// handle is intentionally never closed; O_APPEND writes hit the OS directly
// (no userspace buffering to flush) so no event is lost on process exit.
func newRoutingEventLogger(path string) *routingEventLogger {
	f, err := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		logging.Warnf("routing events: cannot open %s (%v); routing event log disabled", path, err)
		return nil
	}
	return &routingEventLogger{f: f, path: path}
}

// append serializes ev as one JSON line. Safe to call on a nil logger (no-op).
func (l *routingEventLogger) append(ev routingEvent) {
	if l == nil || l.f == nil {
		return
	}
	line, err := json.Marshal(ev)
	if err != nil {
		logging.Warnf("routing events: marshal failed: %v", err)
		return
	}
	line = append(line, '\n')
	l.mu.Lock()
	_, werr := l.f.Write(line)
	l.mu.Unlock()
	if werr != nil {
		logging.Warnf("routing events: write to %s failed: %v", l.path, werr)
	}
}
