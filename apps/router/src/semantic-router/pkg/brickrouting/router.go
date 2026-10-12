package brickrouting

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"os"
	"sort"
	"strings"
	"time"

	candle "github.com/regolo-ai/brick-SR1/candle-binding"
	"github.com/regolo-ai/brick-SR1/apps/router/src/semantic-router/pkg/config"
	"github.com/regolo-ai/brick-SR1/apps/router/src/semantic-router/pkg/observability/logging"
)

const (
	defaultPriorStrength     = 8.0
	defaultOverPenaltyLambda = 0.05
	defaultTieEpsilon        = 0.03
	defaultClipMin           = 0.02
	defaultClipMax           = 0.98
	defaultCapabilityModelID = "models/modernbert-capability-classifier"
	defaultComplexityBaseURL = "http://127.0.0.1:8094"
)

var defaultCapabilities = []string{
	"coding",
	"creative_synthesis",
	"instruction_following",
	"math_reasoning",
	"planning_agentic",
	"world_knowledge",
}

type Router struct {
	cfg          *config.RouterConfig
	skillCfg     config.SkillRouterConfig
	capabilities []string
	capIndex     map[string]int
	capability   *capabilityClassifier
	complexity   *complexityClient
	mathCfg      mathConfig
}

type mathConfig struct {
	tau        map[string]float64
	lambdaOver float64
	tieEps     float64
	clipMin    float64
	clipMax    float64
}

type Result struct {
	Model                string
	Reason               string
	MatchedKeyword       string
	Capability           map[string]float64
	ComplexityLabel      string
	ComplexityConfidence float64
	TauQuery             float64
	Scores               []ModelScore
}

type ModelScore struct {
	Model           string  `json:"model"`
	Distance        float64 `json:"distance"`
	ExpectedSuccess float64 `json:"expected_success"`
}

func New(cfg *config.RouterConfig) (*Router, error) {
	if cfg == nil {
		return nil, fmt.Errorf("router config is nil")
	}
	skillCfg := cfg.SkillRouter
	if !skillCfg.Enabled {
		return nil, fmt.Errorf("skill_router.enabled is false")
	}
	applyDefaults(&skillCfg)

	capIndex := make(map[string]int, len(skillCfg.Capabilities))
	for i, capability := range skillCfg.Capabilities {
		capIndex[capability] = i
	}

	capability, err := newCapabilityClassifier(skillCfg.CapabilityModel, skillCfg.Capabilities)
	if err != nil {
		return nil, err
	}

	return &Router{
		cfg:          cfg,
		skillCfg:     skillCfg,
		capabilities: skillCfg.Capabilities,
		capIndex:     capIndex,
		capability:   capability,
		complexity:   newComplexityClient(cfg, skillCfg.ComplexityModel),
		mathCfg:      newMathConfig(skillCfg.Math),
	}, nil
}

func (r *Router) Route(ctx context.Context, text string) (*Result, error) {
	text = strings.TrimSpace(text)
	if text == "" {
		return nil, fmt.Errorf("no text available for Brick routing")
	}

	matches := r.matchKeywords(text)
	if best := bestOverride(matches); best != nil {
		logging.Infof("[Brick2] keyword override matched rule=%s model=%s importance=%d",
			best.rule.Name, best.rule.Model, best.importance)
		return &Result{
			Model:           best.rule.Model,
			Reason:          "keyword_override",
			MatchedKeyword:  best.rule.Name,
			Capability:      uniformCapabilities(r.capabilities),
			ComplexityLabel: "skipped",
			TauQuery:        r.mathCfg.tau["medium"],
		}, nil
	}

	capCh := make(chan capabilityResult, 1)
	complexityCh := make(chan complexityResult, 1)
	go func() {
		p, err := r.capability.Classify(text)
		capCh <- capabilityResult{probabilities: p, err: err}
	}()
	go func() {
		label, confidence := r.complexity.Classify(ctx, text)
		complexityCh <- complexityResult{label: label, confidence: confidence}
	}()

	capRes := <-capCh
	if capRes.err != nil {
		return nil, capRes.err
	}
	probabilities := r.applyKeywordBiases(capRes.probabilities, matches)

	complexityRes := <-complexityCh
	tauQuery := r.tauQuery(complexityRes.label, complexityRes.confidence)
	scores := r.scoreModels(probabilities, tauQuery)
	if len(scores) == 0 {
		return nil, fmt.Errorf("no skill_router.models configured")
	}

	selected := scores[0].Model
	reason := "skill_vector"
	if len(matches) > 0 {
		reason = "skill_vector_keyword_bias"
	}

	return &Result{
		Model:                selected,
		Reason:               reason,
		MatchedKeyword:       joinedRuleNames(matches),
		Capability:           toCapabilityMap(r.capabilities, probabilities),
		ComplexityLabel:      complexityRes.label,
		ComplexityConfidence: complexityRes.confidence,
		TauQuery:             tauQuery,
		Scores:               scores,
	}, nil
}

func (r *Router) scoreModels(probabilities []float64, tauQuery float64) []ModelScore {
	queryLogit := logit(clamp(tauQuery, r.mathCfg.clipMin, r.mathCfg.clipMax))
	scores := make([]ModelScore, 0, len(r.skillCfg.Models))
	for _, model := range r.skillCfg.Models {
		var underSum, overSum, expected float64
		for i, p := range probabilities {
			requirement := p * queryLogit
			modelValue := p * logit(clamp(model.SkillVector[i], r.mathCfg.clipMin, r.mathCfg.clipMax))
			under := math.Max(0, requirement-modelValue)
			over := math.Max(0, modelValue-requirement)
			underSum += under * under
			overSum += over * over
			expected += p * model.SkillVector[i]
		}
		distance := math.Sqrt(underSum + r.mathCfg.lambdaOver*overSum)
		scores = append(scores, ModelScore{
			Model:           model.Model,
			Distance:        distance,
			ExpectedSuccess: expected,
		})
	}
	sort.SliceStable(scores, func(i, j int) bool {
		if math.Abs(scores[i].Distance-scores[j].Distance) < r.mathCfg.tieEps {
			if math.Abs(scores[i].ExpectedSuccess-scores[j].ExpectedSuccess) > 1e-9 {
				return scores[i].ExpectedSuccess > scores[j].ExpectedSuccess
			}
			return modelTieCost(r.skillCfg.Models, scores[i].Model) < modelTieCost(r.skillCfg.Models, scores[j].Model)
		}
		return scores[i].Distance < scores[j].Distance
	})
	return scores
}

func (r *Router) tauQuery(label string, confidence float64) float64 {
	label = strings.ToLower(strings.TrimSpace(label))
	if confidence < 0 {
		confidence = 0
	}
	if confidence > 1 {
		confidence = 1
	}
	tauLabel, ok := r.mathCfg.tau[label]
	if !ok {
		tauLabel = r.mathCfg.tau["medium"]
		confidence = 0
	}
	return confidence*tauLabel + (1-confidence)*r.mathCfg.tau["medium"]
}

func applyDefaults(cfg *config.SkillRouterConfig) {
	if len(cfg.Capabilities) == 0 {
		cfg.Capabilities = append([]string(nil), defaultCapabilities...)
	}
	if len(cfg.CapabilityModel.Labels) == 0 {
		cfg.CapabilityModel.Labels = append([]string(nil), cfg.Capabilities...)
	}
	if cfg.CapabilityModel.ModelID == "" && cfg.CapabilityModel.LocalPath == "" {
		cfg.CapabilityModel.ModelID = defaultCapabilityModelID
	}
	if cfg.ComplexityModel.ModelID == "" {
		cfg.ComplexityModel.ModelID = "regolo/brick-complexity-2-eco"
	}
	if cfg.ComplexityModel.BaseModelID == "" {
		cfg.ComplexityModel.BaseModelID = "Qwen/Qwen3.5-0.8B"
	}
}

func newMathConfig(cfg config.SkillRouterMathConfig) mathConfig {
	tau := map[string]float64{
		"easy":   0.55,
		"medium": 0.72,
		"hard":   0.88,
	}
	for key, value := range cfg.Tau {
		tau[strings.ToLower(strings.TrimSpace(key))] = value
	}
	lambda := cfg.OverPenaltyLambda
	if lambda == 0 {
		lambda = defaultOverPenaltyLambda
	}
	tieEps := cfg.TieEpsilon
	if tieEps == 0 {
		tieEps = defaultTieEpsilon
	}
	clipMin := cfg.ClipMin
	if clipMin == 0 {
		clipMin = defaultClipMin
	}
	clipMax := cfg.ClipMax
	if clipMax == 0 {
		clipMax = defaultClipMax
	}
	return mathConfig{tau: tau, lambdaOver: lambda, tieEps: tieEps, clipMin: clipMin, clipMax: clipMax}
}

type capabilityClassifier struct {
	modelPath string
	labels    []string
	sidecar   *systemoneClient
}

type capabilityResult struct {
	probabilities []float64
	err           error
}

// systemoneClient talks to a brick-systemone-server sidecar (POST /vectors).
// The sidecar returns raw sigmoid probabilities in canonical DIMS order;
// mapping onto c.labels is done by dimension name.
type systemoneClient struct {
	baseURL     string
	bearerToken string
	httpClient  *http.Client
}

type systemoneVectorsResponse struct {
	Vectors []float64 `json:"vectors"`
	Dims    []string  `json:"dims"`
}

func newSystemoneClient(cfg config.SkillRouterCapabilityModelConfig) *systemoneClient {
	baseURL := strings.TrimRight(cfg.SidecarURL, "/")
	if baseURL == "" {
		return nil
	}
	timeout := 30 * time.Second
	if cfg.SidecarTimeoutSeconds > 0 {
		timeout = time.Duration(cfg.SidecarTimeoutSeconds) * time.Second
	}
	token := strings.TrimSpace(cfg.SidecarBearerToken)
	if token == "" && cfg.SidecarTokenFile != "" {
		if b, err := os.ReadFile(cfg.SidecarTokenFile); err == nil {
			token = strings.TrimSpace(string(b))
		}
	}
	return &systemoneClient{
		baseURL:     baseURL,
		bearerToken: token,
		httpClient:  &http.Client{Timeout: timeout},
	}
}

func (c *systemoneClient) Vectors(ctx context.Context, text string) ([]float64, []string, error) {
	body, err := json.Marshal(map[string]string{"text": text})
	if err != nil {
		return nil, nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+"/vectors", bytes.NewReader(body))
	if err != nil {
		return nil, nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	if c.bearerToken != "" {
		req.Header.Set("Authorization", "Bearer "+c.bearerToken)
	}
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, nil, fmt.Errorf("systemone sidecar status=%d", resp.StatusCode)
	}
	var out systemoneVectorsResponse
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return nil, nil, err
	}
	if len(out.Vectors) == 0 || len(out.Vectors) != len(out.Dims) {
		return nil, nil, fmt.Errorf("systemone sidecar returned %d vectors for %d dims", len(out.Vectors), len(out.Dims))
	}
	return out.Vectors, out.Dims, nil
}

func newCapabilityClassifier(cfg config.SkillRouterCapabilityModelConfig, capabilities []string) (*capabilityClassifier, error) {
	modelPath := cfg.LocalPath
	if modelPath == "" {
		modelPath = cfg.ModelID
	}
	if modelPath == "" {
		modelPath = defaultCapabilityModelID
	}
	modelPath = config.ResolveModelPath(modelPath)
	labels := cfg.Labels
	if len(labels) == 0 {
		labels = capabilities
	}
	c := &capabilityClassifier{modelPath: modelPath, labels: labels, sidecar: newSystemoneClient(cfg)}
	if c.sidecar != nil {
		logging.Infof("[Brick2] capability classifier: sidecar primary %s, Candle fallback %s", c.sidecar.baseURL, modelPath)
		// Best-effort Candle init: sidecar is primary, so a missing local
		// model only disables the fallback instead of failing startup.
		if err := candle.InitModernBertClassifier(modelPath, cfg.UseCPU); err != nil {
			logging.Warnf("[Brick2] Candle fallback unavailable: %v", err)
			return c, nil
		}
		return c, nil
	}
	logging.Infof("[Brick2] initializing capability classifier: %s", modelPath)
	if err := candle.InitModernBertClassifier(modelPath, cfg.UseCPU); err != nil {
		return nil, fmt.Errorf("initialize capability classifier %q: %w", modelPath, err)
	}
	return c, nil
}

func (c *capabilityClassifier) Classify(text string) ([]float64, error) {
	if c.sidecar != nil {
		if p, err := c.classifySidecar(text); err == nil {
			return p, nil
		} else {
			logging.Warnf("[Brick2] sidecar capability failed, Candle fallback: %v", err)
		}
	}
	return c.classifyCandle(text)
}

// classifySidecar maps sidecar dims onto c.labels by name, then applies the
// same normalize() as the Candle path so downstream routing math is unchanged.
func (c *capabilityClassifier) classifySidecar(text string) ([]float64, error) {
	ctx, cancel := context.WithTimeout(context.Background(), c.sidecar.httpClient.Timeout)
	defer cancel()
	vectors, dims, err := c.sidecar.Vectors(ctx, text)
	if err != nil {
		return nil, err
	}
	byDim := make(map[string]float64, len(dims))
	for i, d := range dims {
		byDim[d] = vectors[i]
	}
	out := make([]float64, len(c.labels))
	for i, l := range c.labels {
		v, ok := byDim[l]
		if !ok {
			return nil, fmt.Errorf("sidecar response missing dim %q", l)
		}
		out[i] = v
	}
	return normalize(out), nil
}

func (c *capabilityClassifier) classifyCandle(text string) ([]float64, error) {
	result, err := candle.ClassifyModernBertTextWithProbabilities(text)
	if err != nil {
		return nil, fmt.Errorf("capability classification failed: %w", err)
	}
	if len(result.Probabilities) != len(c.labels) {
		if len(result.Probabilities) == 0 && result.Class >= 0 && result.Class < len(c.labels) {
			out := make([]float64, len(c.labels))
			out[result.Class] = 1
			return out, nil
		}
		return nil, fmt.Errorf("capability classifier returned %d probabilities for %d labels", len(result.Probabilities), len(c.labels))
	}
	out := make([]float64, len(result.Probabilities))
	for i, p := range result.Probabilities {
		out[i] = float64(p)
	}
	return normalize(out), nil
}

type complexityClient struct {
	baseURL     string
	bearerToken string
	httpClient  *http.Client
}

type complexityResult struct {
	label      string
	confidence float64
}

func newComplexityClient(cfg *config.RouterConfig, skillCfg config.SkillRouterComplexityModelConfig) *complexityClient {
	timeout := 5 * time.Second
	if skillCfg.TimeoutSeconds > 0 {
		timeout = time.Duration(skillCfg.TimeoutSeconds) * time.Second
	} else if cfg.ComplexityService != nil && cfg.ComplexityService.TimeoutSeconds > 0 {
		timeout = time.Duration(cfg.ComplexityService.TimeoutSeconds) * time.Second
	}

	baseURL := strings.TrimRight(skillCfg.BaseURL, "/")
	if baseURL == "" && cfg.ComplexityService != nil {
		baseURL = strings.TrimRight(cfg.ComplexityService.BaseURL, "/")
		if baseURL == "" && cfg.ComplexityService.Address != "" {
			port := cfg.ComplexityService.Port
			if port == 0 {
				port = 8094
			}
			baseURL = fmt.Sprintf("http://%s:%d", cfg.ComplexityService.Address, port)
		}
	}
	if baseURL == "" {
		baseURL = defaultComplexityBaseURL
	}

	token := strings.TrimSpace(skillCfg.BearerToken)
	if token == "" && skillCfg.BearerTokenFile != "" {
		if b, err := os.ReadFile(skillCfg.BearerTokenFile); err == nil {
			token = strings.TrimSpace(string(b))
		}
	}
	if token == "" && cfg.ComplexityService != nil {
		if resolved, err := cfg.ComplexityService.ResolveBearerToken(); err == nil {
			token = resolved
		}
	}

	return &complexityClient{
		baseURL:     baseURL,
		bearerToken: token,
		httpClient:  &http.Client{Timeout: timeout},
	}
}

func (c *complexityClient) Classify(ctx context.Context, text string) (string, float64) {
	body, _ := json.Marshal(map[string]string{"text": text})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+"/classify", bytes.NewReader(body))
	if err != nil {
		logging.Warnf("[Brick2] complexity fallback: %v", err)
		return "medium", 1.0
	}
	req.Header.Set("Content-Type", "application/json")
	if c.bearerToken != "" {
		req.Header.Set("Authorization", "Bearer "+c.bearerToken)
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		logging.Warnf("[Brick2] complexity fallback: %v", err)
		return "medium", 1.0
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		logging.Warnf("[Brick2] complexity fallback: status=%d", resp.StatusCode)
		return "medium", 1.0
	}
	var decoded struct {
		Label      string  `json:"label"`
		Confidence float64 `json:"confidence"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&decoded); err != nil {
		logging.Warnf("[Brick2] complexity fallback: %v", err)
		return "medium", 1.0
	}
	label := strings.ToLower(strings.TrimSpace(decoded.Label))
	if label != "easy" && label != "medium" && label != "hard" {
		label = "medium"
		decoded.Confidence = 1.0
	}
	return label, decoded.Confidence
}
