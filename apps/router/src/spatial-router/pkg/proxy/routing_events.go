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

	// Per-turn token breakdown, filled in after the response streams. These are
	// the inputs the offline counterfactual replay (pkg/proxy/replay.go) needs to
	// price a turn on both the served and the candidate model: fresh (uncached)
	// input, the two prompt-cache tiers, and output. CtxTokens above is their
	// input sum kept for backward compatibility; these break it out. omitempty so
	// pre-enrichment log records (which lack them) round-trip unchanged and the
	// replay degrades them to the prefix-only figure from EstSwitchDelta.
	FreshInputTokens    int64 `json:"fresh_input_tokens,omitempty"`
	CacheReadTokens     int64 `json:"cache_read_tokens,omitempty"`
	CacheCreationTokens int64 `json:"cache_creation_tokens,omitempty"`
	OutputTokens        int64 `json:"output_tokens,omitempty"`

	// RateLimitHeaders captures the Anthropic plan/rate-limit state observed on
	// the upstream response, keyed by the lowercase header name with the
	// "anthropic-ratelimit-" prefix stripped (e.g. "unified-5h-utilization").
	// The capture is prefix-generic so it works both for the unified headers a
	// subscription (OAuth) account receives and for the per-API-key variants.
	// This is the ground truth the plan-savings A/B suite reads to measure real
	// Claude plan consumption per branch.
	RateLimitHeaders map[string]string `json:"ratelimit_headers,omitempty"`

	// RequestTag is an attribution tag set by test harnesses via the
	// x-brick-ab-tag request header (stripped before forwarding upstream).
	// Empty outside a harness run.
	RequestTag string `json:"request_tag,omitempty"`

	// UpstreamStatus is the HTTP status code returned by the Anthropic
	// upstream, so offline analysis can detect 429s and exclude error turns.
	UpstreamStatus int `json:"upstream_status,omitempty"`

	// RequestedModel is the model the client asked for before any rewrite:
	// "brick-*" on the routed path, the concrete claude-* name on the native
	// passthrough path (where it equals ServedModel).
	RequestedModel string `json:"requested_model,omitempty"`

	// ClassifierPromptChars is the length in characters of the text sent to the
	// complexity classifier for this request (0 on the native path). Basis for
	// estimating the external classifier cost of a routed branch.
	ClassifierPromptChars int64 `json:"classifier_prompt_chars,omitempty"`
}

// modePassthroughNative labels routing events emitted on the native-model
// passthrough path (explicit claude-* model, skill router bypassed). It is a
// proxy-local mode string, distinct from the config routing modes, so the
// offline aggregators can separate plan traffic from brick-routed traffic.
const modePassthroughNative = "passthrough_native"

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
