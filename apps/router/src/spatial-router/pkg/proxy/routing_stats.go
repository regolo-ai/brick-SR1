package proxy

import (
	"bufio"
	"encoding/json"
	"io"
	"math"
	"net/http"
	"os"
	"sort"

	"github.com/regolo-ai/brick-SR1/apps/router/src/spatial-router/pkg/economics"
	"github.com/regolo-ai/brick-SR1/apps/router/src/spatial-router/pkg/observability/logging"
)

// routingModeStats is the aggregate for one routing mode over the whole event
// log. MedianSwitchDeltaHeld is the prefix-reprocessing cost a hold avoided —
// only half the picture, since it does not net out the extra cost of keeping a
// pricier model warm for the rest of a held turn (output included), so it reads
// optimistically. NetUnits/SavingsPct (populated when a pricing table is
// available and at least one turn carries the per-turn token breakdown) are the
// honest figure: the same held turns priced twice, once as served and once under
// the no-sticky counterfactual (see replay.go), summed. Latency percentiles are
// Brick's end-to-end view (nearest-rank).
type routingModeStats struct {
	Mode                  string  `json:"mode"`
	Requests              int     `json:"requests"`
	Sessions              int     `json:"sessions"`
	HeldRequests          int     `json:"held_requests"`
	LatencyP50Ms          int64   `json:"latency_p50_ms"`
	LatencyP95Ms          int64   `json:"latency_p95_ms"`
	MedianSwitchDelta     float64 `json:"median_switch_delta_price_units"`
	MedianSwitchDeltaHeld float64 `json:"median_switch_delta_price_units_held"`

	// Net-total counterfactual fields (see replay.go), populated only when a
	// pricing table is available and PricedTurns > 0 for this mode; omitted
	// (zero-valued) otherwise so a missing net is never confused with a real
	// zero. HeldTurnsSticky/HeldTurnsWorse count of held turns where sticky was
	// cheaper vs costlier than the no-sticky counterfactual, respectively.
	PricedRequests  int      `json:"priced_requests,omitempty"`
	HeldTurnsSticky int      `json:"held_turns_where_sticky_cheaper,omitempty"`
	HeldTurnsWorse  int      `json:"held_turns_where_sticky_costlier,omitempty"`
	NetUnits        *float64 `json:"net_units_sticky_minus_no_sticky,omitempty"`
	SavingsPct      *float64 `json:"savings_pct,omitempty"`

	// Smartsqueeze compaction fields, populated from routingEvent.EstSavedTokens.
	// SqueezeTurns is turns where the compactor cleared something (est_saved > 0);
	// EstTokensSaved{Total,Median} summarize the prefix tokens removed. EstUnitsSaved
	// prices that saving as an avoided cold re-prefill (cache-write tier) on the
	// served model, filled only when a pricing table is available (see
	// mergeReplayIntoStats); a nil pointer means "not priced", not a real zero.
	SqueezeTurns         int      `json:"squeeze_turns,omitempty"`
	EstTokensSavedTotal  int64    `json:"squeeze_est_tokens_saved_total,omitempty"`
	EstTokensSavedMedian int64    `json:"squeeze_est_tokens_saved_median,omitempty"`
	EstUnitsSaved        *float64 `json:"squeeze_est_units_saved,omitempty"`

	// refServedModel is the mode's most-served model, used only as the pricing
	// reference for EstUnitsSaved. Not serialized.
	refServedModel string `json:"-"`
}

// routingStatsResponse is the /api/v1/routing/stats payload: one row per mode
// observed in the log, plus totals. Designed to be safely pollable at any point
// (empty log -> 200 with an explanatory note, never an error), mirroring the
// economics endpoint's tolerance.
type routingStatsResponse struct {
	Modes         []routingModeStats `json:"modes"`
	TotalRequests int                `json:"total_requests"`
	TotalSessions int                `json:"total_sessions"`
	Note          string             `json:"note,omitempty"`
}

// handleRoutingStats reads the append-only routing event log and returns the
// per-mode promotion-gate aggregates: distinct dev sessions (by session_key),
// median realized savings (switch delta on held turns), and p50/p95 end-to-end
// latency. GET-only. Reads the file fresh on every call so it reflects the log
// written by the same process (the writer holds a separate append handle).
func (s *Server) handleRoutingStats(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	if s.routingEventPath == "" {
		writeJSON(w, http.StatusOK, routingStatsResponse{Note: "routing event log not configured"})
		return
	}

	f, err := os.Open(s.routingEventPath)
	if err != nil {
		if os.IsNotExist(err) {
			writeJSON(w, http.StatusOK, routingStatsResponse{Note: "no routing events recorded yet"})
			return
		}
		logging.Warnf("routing stats: cannot read %s: %v", s.routingEventPath, err)
		writeJSON(w, http.StatusOK, routingStatsResponse{Note: "routing event log unreadable"})
		return
	}
	defer f.Close()

	resp := aggregateRoutingEvents(f)

	// Merge in the net-total counterfactual when pricing is available: rewind
	// and re-scan the same file (aggregateRoutingEvents already consumed the
	// reader) rather than open it twice, since routingEventLog appends do not
	// invalidate an already-open read handle.
	if s.pricingTable != nil {
		if _, serr := f.Seek(0, io.SeekStart); serr == nil {
			mergeReplayIntoStats(&resp, replayCounterfactual(f, s.pricingTable))
		}
		priceSqueezeSavings(&resp, s.pricingTable)
	}

	writeJSON(w, http.StatusOK, resp)
}

// priceSqueezeSavings fills EstUnitsSaved for each mode that compacted anything,
// pricing the total tokens saved as an avoided cold re-prefill: the whole saved
// prefix would have been re-read as a cache WRITE on the newly switched model, so
// its value is turnCost(cacheWrite=savedTokens) on the mode's reference served
// model. Left nil when there is nothing to price or the model is unknown, so a
// missing figure is never read as a real zero.
func priceSqueezeSavings(resp *routingStatsResponse, table *economics.PricingTable) {
	for i := range resp.Modes {
		m := &resp.Modes[i]
		if m.EstTokensSavedTotal <= 0 || m.refServedModel == "" {
			continue
		}
		price, ok := table.Price(m.refServedModel)
		if !ok {
			continue
		}
		units := turnCost(0, 0, m.EstTokensSavedTotal, 0, price)
		m.EstUnitsSaved = &units
	}
}

// mergeReplayIntoStats fills the net-total fields of resp.Modes from a replay
// summary computed over the same event log, matching rows by mode name. Modes
// present in the replay but absent from resp (should not happen, both derive
// from the same log) are ignored rather than appended, keeping the response's
// mode set defined solely by aggregateRoutingEvents.
func mergeReplayIntoStats(resp *routingStatsResponse, replay ReplaySummary) {
	byMode := make(map[string]ReplayModeSummary, len(replay.Modes))
	for _, m := range replay.Modes {
		byMode[m.Mode] = m
	}
	for i := range resp.Modes {
		rm, ok := byMode[resp.Modes[i].Mode]
		if !ok || rm.PricedTurns == 0 {
			continue
		}
		net := rm.NetUnits
		pct := rm.SavingsPct
		resp.Modes[i].PricedRequests = rm.PricedTurns
		resp.Modes[i].HeldTurnsSticky = rm.HeldTurnsSticky
		resp.Modes[i].HeldTurnsWorse = rm.HeldTurnsWorse
		resp.Modes[i].NetUnits = &net
		resp.Modes[i].SavingsPct = &pct
	}
}

// routingModeAcc accumulates one mode's events before summarization.
type routingModeAcc struct {
	sessions    map[string]struct{}
	latencies   []int64
	deltas      []float64
	deltasHeld  []float64
	savedTokens []int64        // per-turn EstSavedTokens where > 0 (smartsqueeze)
	servedSeen  map[string]int // served model -> count, to pick a pricing reference
	requests    int
	held        int
}

// aggregateRoutingEvents parses a JSONL routing event stream (one routingEvent
// per line, malformed lines skipped) and summarizes it per mode. Kept separate
// from the handler so it can be unit-tested on a plain reader.
func aggregateRoutingEvents(r io.Reader) routingStatsResponse {
	byMode := map[string]*routingModeAcc{}
	allSessions := map[string]struct{}{}
	total := 0

	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 0, 64*1024), 4*1024*1024) // tolerate long lines
	for sc.Scan() {
		line := sc.Bytes()
		if len(line) == 0 {
			continue
		}
		var ev routingEvent
		if err := json.Unmarshal(line, &ev); err != nil {
			continue
		}
		total++
		acc := byMode[ev.Mode]
		if acc == nil {
			acc = &routingModeAcc{sessions: map[string]struct{}{}, servedSeen: map[string]int{}}
			byMode[ev.Mode] = acc
		}
		acc.requests++
		if ev.SessionKey != "" {
			acc.sessions[ev.SessionKey] = struct{}{}
			allSessions[ev.SessionKey] = struct{}{}
		}
		acc.latencies = append(acc.latencies, ev.E2ELatencyMs)
		acc.deltas = append(acc.deltas, ev.EstSwitchDelta)
		if ev.ServedModel != "" {
			acc.servedSeen[ev.ServedModel]++
		}
		// Smartsqueeze: a turn that actually compacted carries est_saved_tokens > 0.
		if ev.EstSavedTokens > 0 {
			acc.savedTokens = append(acc.savedTokens, ev.EstSavedTokens)
		}
		// A held turn is where sticky replaced the candidate: candidate != served
		// (both known). Only these realize the avoided reprocessing cost.
		if ev.CandidateModel != "" && ev.ServedModel != "" && ev.CandidateModel != ev.ServedModel {
			acc.held++
			acc.deltasHeld = append(acc.deltasHeld, ev.EstSwitchDelta)
		}
	}

	modes := make([]routingModeStats, 0, len(byMode))
	for mode, acc := range byMode {
		modes = append(modes, routingModeStats{
			Mode:                  mode,
			Requests:              acc.requests,
			Sessions:              len(acc.sessions),
			HeldRequests:          acc.held,
			LatencyP50Ms:          percentileInt64(acc.latencies, 0.50),
			LatencyP95Ms:          percentileInt64(acc.latencies, 0.95),
			MedianSwitchDelta:     medianFloat(acc.deltas),
			MedianSwitchDeltaHeld: medianFloat(acc.deltasHeld),
			SqueezeTurns:          len(acc.savedTokens),
			EstTokensSavedTotal:   sumInt64(acc.savedTokens),
			EstTokensSavedMedian:  medianOfInt64(acc.savedTokens),
			refServedModel:        mostFrequent(acc.servedSeen),
		})
	}
	sort.Slice(modes, func(i, j int) bool { return modes[i].Mode < modes[j].Mode })

	return routingStatsResponse{
		Modes:         modes,
		TotalRequests: total,
		TotalSessions: len(allSessions),
	}
}

// percentileInt64 returns the nearest-rank q-percentile of vals (0 for empty).
// Sorts a copy so the caller's slice order is preserved.
func percentileInt64(vals []int64, q float64) int64 {
	if len(vals) == 0 {
		return 0
	}
	s := append([]int64(nil), vals...)
	sort.Slice(s, func(i, j int) bool { return s[i] < s[j] })
	rank := int(math.Ceil(q*float64(len(s)))) - 1
	if rank < 0 {
		rank = 0
	}
	if rank >= len(s) {
		rank = len(s) - 1
	}
	return s[rank]
}

// medianFloat returns the median of vals (0 for empty), sorting a copy.
func medianFloat(vals []float64) float64 {
	if len(vals) == 0 {
		return 0
	}
	s := append([]float64(nil), vals...)
	sort.Float64s(s)
	n := len(s)
	if n%2 == 1 {
		return s[n/2]
	}
	return (s[n/2-1] + s[n/2]) / 2
}

// sumInt64 totals a slice (0 for empty).
func sumInt64(vals []int64) int64 {
	var t int64
	for _, v := range vals {
		t += v
	}
	return t
}

// medianOfInt64 returns the nearest-rank median of vals (0 for empty), sorting a
// copy. Nearest-rank (not averaged) matches percentileInt64's convention.
func medianOfInt64(vals []int64) int64 {
	if len(vals) == 0 {
		return 0
	}
	s := append([]int64(nil), vals...)
	sort.Slice(s, func(i, j int) bool { return s[i] < s[j] })
	return s[len(s)/2]
}

// mostFrequent returns the key with the highest count (ties broken by string
// order for determinism), or "" for an empty map.
func mostFrequent(counts map[string]int) string {
	best := ""
	bestN := -1
	for k, n := range counts {
		if n > bestN || (n == bestN && k < best) {
			best, bestN = k, n
		}
	}
	return best
}
