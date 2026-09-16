package proxy

// Persistent, privacy-preserving call history backing the JSON stats API.
// It deliberately contains no request or response payloads.

import (
	"bufio"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/regolo-ai/brick-SR1/apps/router/src/spatial-router/pkg/brickrouting"
)

type callRecord struct {
	CallID               string             `json:"call_id"`
	StartedAt            time.Time          `json:"started_at"`
	FinishedAt           time.Time          `json:"finished_at"`
	Model                string             `json:"model"`
	ReasoningMode        string             `json:"reasoning_mode"`
	RoutingMode          string             `json:"routing_mode"`
	RoutingSource        string             `json:"routing_source"`
	Status               string             `json:"status"`
	Error                string             `json:"error,omitempty"`
	InputTokens          *int64             `json:"input_tokens"`
	OutputTokens         *int64             `json:"output_tokens"`
	Difficulty           *string            `json:"difficulty"`
	DifficultyConfidence *float64           `json:"difficulty_confidence"`
	RoutingParameters    *routingParameters `json:"routing_parameters"`
	RoutingLatencyMS     *int64             `json:"routing_latency_ms"`
	ProviderLatencyMS    *int64             `json:"provider_latency_ms"`
	OverallLatencyMS     *int64             `json:"overall_latency_ms"`
	ClassifierFallback   *bool              `json:"classifier_fallback"`
}

func applyRouteObservation(r *callRecord, route *brickrouting.Result) {
	if route == nil {
		return
	}
	// The current in-process router exposes an error as a failed route rather
	// than silently selecting a fallback. Persist an explicit false so stats can
	// distinguish a successful classifier decision from a skipped/native call.
	fallback := false
	r.ClassifierFallback = &fallback
	difficulty := route.ComplexityLabel
	if difficulty != "" {
		r.Difficulty = &difficulty
	}
	confidence := route.ComplexityConfidence
	r.DifficultyConfidence = &confidence
	tau := route.TauQuery
	p := &routingParameters{CategoryProbabilities: route.Capability, TauQuery: &tau, MatchedRule: route.MatchedKeyword, Reason: route.Reason}
	for _, score := range route.Scores {
		p.CandidateScores = append(p.CandidateScores, candidateScore{Model: score.Model, Score: score.Score, ExpectedSuccess: score.ExpectedSuccess, Distance: score.Distance, UnderCapacity: score.UnderCapacity})
		if score.Model == r.Model {
			selected := score.ExpectedSuccess
			p.SelectedProbability = &selected
		}
	}
	r.RoutingParameters = p
}

// routingParameters is deliberately limited to routing decisions, never prompt
// content or provider payloads. Values are stored at their native precision.
type routingParameters struct {
	CategoryProbabilities map[string]float64 `json:"category_probabilities,omitempty"`
	TauQuery              *float64           `json:"tau_query"`
	MatchedRule           string             `json:"matched_rule,omitempty"`
	Reason                string             `json:"reason,omitempty"`
	CandidateScores       []candidateScore   `json:"candidate_scores,omitempty"`
	SelectedProbability   *float64           `json:"selected_model_probability"`
}
type candidateScore struct {
	Model           string  `json:"model"`
	Score           float64 `json:"score"`
	ExpectedSuccess float64 `json:"expected_success"`
	Distance        float64 `json:"distance"`
	UnderCapacity   float64 `json:"under_capacity"`
}

type callHistory struct {
	path string
	mu   sync.Mutex
}

func newCallHistory(path string) *callHistory { return &callHistory{path: path} }

func newBrickCallID() string {
	b := make([]byte, 12)
	if _, err := rand.Read(b); err != nil {
		return fmt.Sprintf("brick-%d", time.Now().UnixNano())
	}
	return "brick-" + base64.RawURLEncoding.EncodeToString(b)
}

func (h *callHistory) append(r callRecord) error {
	h.mu.Lock()
	defer h.mu.Unlock()
	if err := os.MkdirAll(filepath.Dir(h.path), 0700); err != nil {
		return err
	}
	f, err := os.OpenFile(h.path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	defer f.Close()
	b, err := json.Marshal(r)
	if err != nil {
		return err
	}
	if _, err = f.Write(append(b, '\n')); err != nil {
		return err
	}
	return f.Sync()
}

func (h *callHistory) records() ([]callRecord, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	f, err := os.Open(h.path)
	if os.IsNotExist(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	defer f.Close()
	var out []callRecord
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 4096), 1024*1024)
	for sc.Scan() {
		var r callRecord
		if json.Unmarshal(sc.Bytes(), &r) == nil && r.CallID != "" {
			out = append(out, r)
		}
	}
	return out, sc.Err()
}

func (h *callHistory) clear() error {
	h.mu.Lock()
	defer h.mu.Unlock()
	if err := os.MkdirAll(filepath.Dir(h.path), 0700); err != nil {
		return err
	}
	tmp := h.path + ".clear"
	if err := os.WriteFile(tmp, nil, 0600); err != nil {
		return err
	}
	return os.Rename(tmp, h.path)
}

func sanitizeCallError(err error) string {
	if err == nil {
		return ""
	}
	s := strings.ReplaceAll(err.Error(), "\n", " ")
	if len(s) > 300 {
		s = s[:300]
	}
	return s
}

type statsFilter struct {
	from, to time.Time
	models   map[string]bool
	status   string
}

func filterCalls(all []callRecord, f statsFilter) []callRecord {
	out := make([]callRecord, 0, len(all))
	for _, r := range all {
		if !f.from.IsZero() && r.StartedAt.Before(f.from) {
			continue
		}
		if !f.to.IsZero() && !r.StartedAt.Before(f.to) {
			continue
		}
		if len(f.models) > 0 && !f.models[r.Model] {
			continue
		}
		if f.status != "" && r.Status != f.status {
			continue
		}
		out = append(out, r)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].StartedAt.Equal(out[j].StartedAt) {
			return out[i].CallID > out[j].CallID
		}
		return out[i].StartedAt.After(out[j].StartedAt)
	})
	return out
}
