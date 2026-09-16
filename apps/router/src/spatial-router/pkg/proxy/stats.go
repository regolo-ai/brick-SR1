package proxy

import (
	"encoding/base64"
	"encoding/json"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"
)

type statCounts struct {
	Calls          int64 `json:"calls"`
	CompletedCalls int64 `json:"completed_calls"`
	FailedCalls    int64 `json:"failed_calls"`
	CallsWithUsage int64 `json:"calls_with_usage"`
	InputTokens    int64 `json:"input_tokens"`
	OutputTokens   int64 `json:"output_tokens"`
}
type statMode struct {
	Mode string `json:"mode"`
	statCounts
}
type statsModel struct {
	Model          string     `json:"model"`
	RoutedCalls    int64      `json:"routed_calls"`
	NativeCalls    int64      `json:"native_calls"`
	ReasoningModes []statMode `json:"reasoning_modes"`
	RoutingModes   []statMode `json:"routing_modes"`
	statCounts
}
type statsResponse struct {
	SchemaVersion string          `json:"schema_version"`
	Overall       statCounts      `json:"overall"`
	Models        []statsModel    `json:"models"`
	Difficulty    []statMode      `json:"difficulty"`
	Classifier    classifierStats `json:"classifier"`
	Latencies     latencyStats    `json:"latencies"`
}
type classifierStats struct {
	Calls        int64   `json:"calls"`
	Fallbacks    int64   `json:"fallbacks"`
	FallbackRate float64 `json:"fallback_rate"`
}
type latencySummary struct {
	AverageMS *float64 `json:"average_ms"`
	P50MS     *float64 `json:"p50_ms"`
	P95MS     *float64 `json:"p95_ms"`
}
type latencyStats struct {
	Routing  latencySummary `json:"routing"`
	Provider latencySummary `json:"provider"`
	Overall  latencySummary `json:"overall"`
}

func summarizeLatency(v []int64) latencySummary {
	if len(v) == 0 {
		return latencySummary{}
	}
	sort.Slice(v, func(i, j int) bool { return v[i] < v[j] })
	var sum int64
	for _, n := range v {
		sum += n
	}
	avg := float64(sum) / float64(len(v))
	// nearest-rank percentile, stable and meaningful for small filtered sets.
	pct := func(p float64) *float64 { i := int(float64(len(v)-1)*p + 0.5); x := float64(v[i]); return &x }
	return latencySummary{AverageMS: &avg, P50MS: pct(.5), P95MS: pct(.95)}
}

func addCounts(c *statCounts, r callRecord) {
	c.Calls++
	if r.Status == "completed" {
		c.CompletedCalls++
	} else {
		c.FailedCalls++
	}
	if r.InputTokens != nil || r.OutputTokens != nil {
		c.CallsWithUsage++
		if r.InputTokens != nil {
			c.InputTokens += *r.InputTokens
		}
		if r.OutputTokens != nil {
			c.OutputTokens += *r.OutputTokens
		}
	}
}
func (s *Server) parseStatsFilter(r *http.Request) (statsFilter, error) {
	q := r.URL.Query()
	loc := time.UTC
	if z := q.Get("timezone"); z != "" {
		var e error
		loc, e = time.LoadLocation(z)
		if e != nil {
			return statsFilter{}, e
		}
	}
	parse := func(v string) (time.Time, error) {
		if v == "" {
			return time.Time{}, nil
		}
		if len(v) == 10 {
			return time.ParseInLocation("2006-01-02", v, loc)
		}
		return time.Parse(time.RFC3339, v)
	}
	from, e := parse(q.Get("from"))
	if e != nil {
		return statsFilter{}, e
	}
	to, e := parse(q.Get("to"))
	if e != nil {
		return statsFilter{}, e
	}
	if !from.IsZero() && !to.IsZero() && !from.Before(to) {
		return statsFilter{}, strconv.ErrSyntax
	}
	f := statsFilter{from: from, to: to, status: q.Get("status"), models: map[string]bool{}}
	if f.status != "" && f.status != "completed" && f.status != "failed" {
		return f, strconv.ErrSyntax
	}
	for _, m := range q["model"] {
		if m != "" {
			f.models[m] = true
		}
	}
	return f, nil
}
func modes(m map[string]*statCounts) []statMode {
	out := make([]statMode, 0, len(m))
	for k, v := range m {
		out = append(out, statMode{Mode: k, statCounts: *v})
	}
	return out
}
func (s *Server) handleStats(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodPost && r.URL.Path == "/api/v1/stats/clear" {
		if s.callHistory == nil {
			writeError(w, 500, "call history unavailable")
			return
		}
		if err := s.callHistory.clear(); err != nil {
			writeError(w, 500, "failed to clear call history")
			return
		}
		writeJSON(w, 200, map[string]any{"schema_version": "2.0", "cleared": true})
		return
	}
	if r.Method != http.MethodGet {
		writeError(w, 405, "method not allowed")
		return
	}
	f, err := s.parseStatsFilter(r)
	if err != nil {
		writeError(w, 400, "invalid stats filter")
		return
	}
	all, err := s.callHistory.records()
	if err != nil {
		writeError(w, 500, "failed to read call history")
		return
	}
	all = filterCalls(all, f)
	if r.URL.Path == "/api/v1/stats/all" {
		s.handleStatsAll(w, r, all)
		return
	}
	prefix := "/api/v1/stats/"
	if strings.HasPrefix(r.URL.Path, prefix) {
		id := strings.TrimPrefix(r.URL.Path, prefix)
		for _, x := range all {
			if x.CallID == id {
				writeJSON(w, 200, x)
				return
			}
		}
		writeError(w, 404, "call not found")
		return
	}
	by := map[string]*statsModel{}
	resp := statsResponse{SchemaVersion: "2.0"}
	difficulty := map[string]*statCounts{}
	var routingLatency, providerLatency, overallLatency []int64
	for _, x := range all {
		row := by[x.Model]
		if row == nil {
			row = &statsModel{Model: x.Model}
			by[x.Model] = row
		}
		addCounts(&row.statCounts, x)
		if x.RoutingSource == "native" {
			row.NativeCalls++
		} else {
			row.RoutedCalls++
		}
		if x.RoutingSource == "routed" && x.Difficulty != nil {
			if difficulty[*x.Difficulty] == nil {
				difficulty[*x.Difficulty] = &statCounts{}
			}
			addCounts(difficulty[*x.Difficulty], x)
		}
		if x.ClassifierFallback != nil {
			resp.Classifier.Calls++
			if *x.ClassifierFallback {
				resp.Classifier.Fallbacks++
			}
		}
		if x.RoutingLatencyMS != nil {
			routingLatency = append(routingLatency, *x.RoutingLatencyMS)
		}
		if x.ProviderLatencyMS != nil {
			providerLatency = append(providerLatency, *x.ProviderLatencyMS)
		}
		if x.OverallLatencyMS != nil {
			overallLatency = append(overallLatency, *x.OverallLatencyMS)
		}
		rm := map[string]*statCounts{}
		for _, v := range row.ReasoningModes {
			v := v
			rm[v.Mode] = &v.statCounts
		}
		if rm[x.ReasoningMode] == nil {
			rm[x.ReasoningMode] = &statCounts{}
		}
		addCounts(rm[x.ReasoningMode], x)
		row.ReasoningModes = modes(rm)
		xm := map[string]*statCounts{}
		for _, v := range row.RoutingModes {
			v := v
			xm[v.Mode] = &v.statCounts
		}
		if xm[x.RoutingMode] == nil {
			xm[x.RoutingMode] = &statCounts{}
		}
		addCounts(xm[x.RoutingMode], x)
		row.RoutingModes = modes(xm)
	}
	for _, x := range all {
		addCounts(&resp.Overall, x)
	}
	for _, row := range by {
		resp.Models = append(resp.Models, *row)
	}
	for label, counts := range difficulty {
		resp.Difficulty = append(resp.Difficulty, statMode{Mode: label, statCounts: *counts})
	}
	if resp.Classifier.Calls > 0 {
		resp.Classifier.FallbackRate = float64(resp.Classifier.Fallbacks) / float64(resp.Classifier.Calls)
	}
	resp.Latencies = latencyStats{Routing: summarizeLatency(routingLatency), Provider: summarizeLatency(providerLatency), Overall: summarizeLatency(overallLatency)}
	writeJSON(w, 200, resp)
}
func (s *Server) handleStatsAll(w http.ResponseWriter, r *http.Request, all []callRecord) {
	limit := 50
	if x := r.URL.Query().Get("limit"); x != "" {
		if n, e := strconv.Atoi(x); e == nil && n > 0 && n <= 200 {
			limit = n
		} else {
			writeError(w, 400, "invalid limit")
			return
		}
	}
	if c := r.URL.Query().Get("cursor"); c != "" {
		b, e := base64.RawURLEncoding.DecodeString(c)
		if e != nil {
			writeError(w, 400, "invalid cursor")
			return
		}
		var p struct {
			T  time.Time
			ID string
		}
		if json.Unmarshal(b, &p) != nil {
			writeError(w, 400, "invalid cursor")
			return
		}
		filtered := all[:0]
		for _, x := range all {
			if x.StartedAt.Before(p.T) || (x.StartedAt.Equal(p.T) && x.CallID < p.ID) {
				filtered = append(filtered, x)
			}
		}
		all = filtered
	}
	more := len(all) > limit
	items := all
	if more {
		items = all[:limit]
	}
	out := map[string]any{"items": items, "has_more": more, "next_cursor": nil}
	if more && len(items) > 0 {
		last := items[len(items)-1]
		b, _ := json.Marshal(struct {
			T  time.Time
			ID string
		}{last.StartedAt, last.CallID})
		out["next_cursor"] = base64.RawURLEncoding.EncodeToString(b)
	}
	writeJSON(w, 200, out)
}
