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
	"sync"
	"time"

	"github.com/regolo-ai/brick-SR1/apps/router/src/spatial-router/pkg/config"
	"github.com/regolo-ai/brick-SR1/apps/router/src/spatial-router/pkg/observability/logging"
	"github.com/regolo-ai/brick-SR1/apps/router/src/spatial-router/pkg/observability/metrics"
	candle "github.com/regolo-ai/brick-SR1/candle-binding"
)

const (
	defaultPriorStrength     = 8.0
	defaultTieEpsilon        = 0.03
	defaultClipMin           = 0.02
	defaultClipMax           = 0.98
	defaultCapabilityModelID = "models/modernbert-capability-classifier"
	defaultComplexityBaseURL = "http://127.0.0.1:8094"

	// defaultOpenAINoLogprobConfidence is the confidence used by the OpenAI
	// complexity protocol when the endpoint returns no usable token logprobs.
	// 0.5 is neutral: tauQueryFrom blends the label and "medium" equally instead
	// of assuming full certainty. Overridable via complexity_service
	// (or skill complexity_model) default_confidence.
	defaultOpenAINoLogprobConfidence = 0.5

	// Locked production math configuration (paper Table 7). These are the
	// calibrated base parameters and preference-knob anchors; the same values
	// are written by `brick init` (apps/cli wizard) so an absent field in the
	// yaml resolves to identical behavior.
	defaultComplexityMu      = 0.345170
	defaultComplexityBias    = 0.822235
	defaultCostPenaltyBeta   = 0.230778
	defaultOverPenaltyLambda = 0.045207
	defaultPreferencePower   = 2.920351
	defaultMaxMuMultiplier   = 13.034935
	defaultMaxBiasShift      = 5.294173
	defaultMaxCostRelief     = 6559.073066
	defaultMaxOverRelief     = 49.547940
	defaultMinMuMultiplier   = 0.081493
	defaultMinBiasShift      = -1.349259
	defaultMinCostBoost      = 8.834043
	defaultMinOverBoost      = 1002.068256
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
	// kp stores the resolved base knob parameters so that RouteWithPreference
	// can derive a per-request mathConfig without touching the singleton mathCfg.
	kp knobParams
}

type mathConfig struct {
	tau     map[string]float64
	tieEps  float64
	clipMin float64
	clipMax float64

	// Effective knob-adjusted parameters (paper sec. brick-knob), computed once
	// at startup from the base values + routing_preference via effectiveParams.
	routingPreference float64
	mu                float64 // effective complexity_mu
	bias              float64 // effective complexity_bias
	beta              float64 // effective cost_penalty_beta
	lambdaOver        float64 // effective over_penalty_lambda
}

// knobParams are the base (r=0) math parameters plus the preference anchors.
type knobParams struct {
	complexityMu      float64
	complexityBias    float64
	costPenaltyBeta   float64
	overPenaltyLambda float64
	preferencePower   float64
	maxMuMultiplier   float64
	maxBiasShift      float64
	maxCostRelief     float64
	maxOverRelief     float64
	minMuMultiplier   float64
	minBiasShift      float64
	minCostBoost      float64
	minOverBoost      float64
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
	Model string `json:"model"`
	// Distance is the pure quality distance D_m.
	Distance float64 `json:"distance"`
	// Score is the cost-penalized routing objective J_m = D_m + beta * cost.
	// Selection minimizes Score, not Distance.
	Score           float64 `json:"score"`
	ExpectedSuccess float64 `json:"expected_success"`
	// UnderCapacity is the pure under-capacity residual sqrt(underSum) in
	// log-odds space: how far the model's skill falls SHORT of the query
	// requirement (over-capacity excluded). Observability-only — it does not
	// affect selection. The proxy uses it to set reasoning effort: a stretched
	// model (high under-capacity) is told to think harder to close the gap.
	UnderCapacity float64 `json:"under_capacity"`
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
		kp:           resolveKnobParams(skillCfg.Math),
	}, nil
}

func (r *Router) Route(ctx context.Context, text string) (*Result, error) {
	return r.RouteWithCandidates(ctx, text, nil)
}

// RouteWithCandidates routes like Route, but restricts model selection to the
// allowlist when it is non-nil (an entry present and true is eligible). It is
// used by the multimodal passthrough path to route only among models that can
// handle the raw modalities present in the request. A nil allowlist means all
// configured models are eligible (identical to Route). The caller allowlist is
// intersected with active_models: candidacy = handles_modality AND active.
func (r *Router) RouteWithCandidates(ctx context.Context, text string, allow map[string]bool) (*Result, error) {
	return r.routeCore(ctx, text, intersectAllow(allow, r.activeAllow()), r.mathCfg)
}

// RouteWithPreference is like Route but overrides the routing-preference knob r
// for this single call, recomputing the effective math parameters on the fly.
// This lets the proxy apply a per-request mode (derived from the client's effort
// field) without mutating the singleton Router or restarting the container.
// r must be in [-1, 1]; values outside the range are clamped.
func (r *Router) RouteWithPreference(ctx context.Context, text string, preference float64) (*Result, error) {
	mu, bias, beta, lambda := effectiveParams(r.kp, preference)
	mc := r.mathCfg
	mc.routingPreference = preference
	mc.mu = mu
	mc.bias = bias
	mc.beta = beta
	mc.lambdaOver = lambda
	// Restrict candidacy to active_models (the pool the user configured). If the
	// list somehow excludes every configured model (hand-edited config), fall
	// back to the full pool: the text path must never fail to route.
	allow := r.activeAllow()
	if allow != nil && !anyAllowed(r.skillCfg.Models, allow) {
		logging.Warnf("[Brick2] active_models excluded every configured model; using full pool")
		allow = nil
	}
	return r.routeCore(ctx, text, allow, mc)
}

// routeCore is the shared implementation used by RouteWithCandidates and
// RouteWithPreference. It runs keyword matching, capability + complexity
// classification in parallel, then selects a model via scoreModels.
func (r *Router) routeCore(ctx context.Context, text string, allow map[string]bool, mc mathConfig) (*Result, error) {
	text = strings.TrimSpace(text)
	if text == "" {
		return nil, fmt.Errorf("no text available for Brick routing")
	}

	matches := r.matchKeywords(text)
	// A keyword override only wins if its model is eligible under the allowlist;
	// otherwise it would break the passthrough guarantee (route to a model that
	// cannot actually consume the raw modality).
	if best := bestOverride(matches); best != nil && modelAllowed(allow, best.rule.Model) {
		logging.Infof("[Brick2] keyword override matched rule=%s model=%s importance=%d",
			best.rule.Name, best.rule.Model, best.importance)
		return &Result{
			Model:           best.rule.Model,
			Reason:          "keyword_override",
			MatchedKeyword:  best.rule.Name,
			Capability:      uniformCapabilities(r.capabilities),
			ComplexityLabel: "skipped",
			TauQuery:        mc.tau["medium"],
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
	tauQuery := tauQueryFrom(mc, complexityRes.label, complexityRes.confidence)
	scores := r.scoreModelsWithConfig(probabilities, tauQuery, allow, mc)
	if len(scores) == 0 {
		if allow != nil {
			return nil, fmt.Errorf("no eligible skill_router.models for the request modalities")
		}
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

func (r *Router) scoreModels(probabilities []float64, tauQuery float64, allow map[string]bool) []ModelScore {
	return r.scoreModelsWithConfig(probabilities, tauQuery, allow, r.mathCfg)
}

func (r *Router) scoreModelsWithConfig(probabilities []float64, tauQuery float64, allow map[string]bool, mc mathConfig) []ModelScore {
	// Difficulty lift in log-odds space (paper sec. brick-math):
	//   z_q = bias + mu * logit(tau_query)
	zq := mc.bias + mc.mu*logit(clamp(tauQuery, mc.clipMin, mc.clipMax))
	scores := make([]ModelScore, 0, len(r.skillCfg.Models))
	for _, model := range r.skillCfg.Models {
		if !modelAllowed(allow, model.Model) {
			continue
		}
		var underSum, overSum, expected float64
		for i, p := range probabilities {
			requirement := p * zq
			modelValue := p * logit(clamp(model.SkillVector[i], mc.clipMin, mc.clipMax))
			under := math.Max(0, requirement-modelValue)
			over := math.Max(0, modelValue-requirement)
			underSum += under * under
			overSum += over * over
			expected += p * model.SkillVector[i]
		}
		distance := math.Sqrt(underSum + mc.lambdaOver*overSum)
		// Cost-penalized routing objective: J_m = D_m + beta * a_m, where a_m is
		// the model's normalized cost (cost_weight).
		score := distance + mc.beta*model.CostWeight
		scores = append(scores, ModelScore{
			Model:           model.Model,
			Distance:        distance,
			Score:           score,
			ExpectedSuccess: expected,
			UnderCapacity:   math.Sqrt(underSum),
		})
	}
	sort.SliceStable(scores, func(i, j int) bool {
		if math.Abs(scores[i].Score-scores[j].Score) < mc.tieEps {
			if math.Abs(scores[i].ExpectedSuccess-scores[j].ExpectedSuccess) > 1e-9 {
				return scores[i].ExpectedSuccess > scores[j].ExpectedSuccess
			}
			return modelTieCost(r.skillCfg.Models, scores[i].Model) < modelTieCost(r.skillCfg.Models, scores[j].Model)
		}
		return scores[i].Score < scores[j].Score
	})
	return scores
}

// modelAllowed reports whether a model is eligible under an allowlist. A nil
// allowlist admits every model; otherwise only entries present and true pass.
func modelAllowed(allow map[string]bool, model string) bool {
	if allow == nil {
		return true
	}
	return allow[model]
}

// activeAllow returns the active_models allowlist as a map, or nil when the list
// is empty (nil = admit all models, preserving backward compatibility).
func (r *Router) activeAllow() map[string]bool {
	if len(r.skillCfg.ActiveModels) == 0 {
		return nil
	}
	allow := make(map[string]bool, len(r.skillCfg.ActiveModels))
	for _, m := range r.skillCfg.ActiveModels {
		allow[m] = true
	}
	return allow
}

// anyAllowed reports whether at least one configured model passes the allowlist.
// Used by the text path to detect an active_models set that excludes every model
// (a hand-edited misconfiguration) so it can fall back to the full pool.
func anyAllowed(models []config.SkillRouterModelConfig, allow map[string]bool) bool {
	for _, m := range models {
		if modelAllowed(allow, m.Model) {
			return true
		}
	}
	return false
}

// intersectAllow returns the models present-and-true in both allowlists. A nil
// operand means "all admitted", so nil ∩ x == x. Mirrors the helper in
// pkg/proxy/brick.go, duplicated here to keep the router package self-contained.
func intersectAllow(a, b map[string]bool) map[string]bool {
	if a == nil {
		return b
	}
	if b == nil {
		return a
	}
	out := make(map[string]bool)
	for model, ok := range a {
		if ok && b[model] {
			out[model] = true
		}
	}
	return out
}

func (r *Router) tauQuery(label string, confidence float64) float64 {
	return tauQueryFrom(r.mathCfg, label, confidence)
}

// tauQueryFrom computes the complexity interpolation parameter from the
// mathConfig, complexity label and classifier confidence. It is a pure function
// so that routeCore can use any mathConfig (including an on-the-fly one built by
// RouteWithPreference) without accessing r.mathCfg directly.
//
// This is where the difficulty signal is consumed: the classifier (local brick
// or remote OpenAI endpoint) supplies ONLY (label, confidence); everything else
// in the routing decision — keyword rules, the capability classifier
// (ModernBERT), per-model skill vectors and cost — is computed locally. The
// label picks tau_label and the confidence shrinks it toward tau_medium when the
// classifier is unsure, so confidence is a real input, not cosmetic.
func tauQueryFrom(mc mathConfig, label string, confidence float64) float64 {
	label = strings.ToLower(strings.TrimSpace(label))
	if confidence < 0 {
		confidence = 0
	}
	if confidence > 1 {
		confidence = 1
	}
	tauLabel, ok := mc.tau[label]
	if !ok {
		tauLabel = mc.tau["medium"]
		confidence = 0
	}
	return confidence*tauLabel + (1-confidence)*mc.tau["medium"]
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

	kp := resolveKnobParams(cfg)

	ptrOr := func(v *float64, def float64) float64 {
		if v == nil {
			return def
		}
		return *v
	}
	preference := ptrOr(cfg.RoutingPreference, 0)

	mu, bias, beta, lambda := effectiveParams(kp, preference)
	return mathConfig{
		tau:               tau,
		tieEps:            tieEps,
		clipMin:           clipMin,
		clipMax:           clipMax,
		routingPreference: preference,
		mu:                mu,
		bias:              bias,
		beta:              beta,
		lambdaOver:        lambda,
	}
}

// resolveKnobParams builds the knobParams from a SkillRouterMathConfig,
// filling in locked production defaults for any absent field. It is extracted
// from newMathConfig so that the Router can store kp once and reuse it in
// RouteWithPreference without re-parsing the config.
func resolveKnobParams(cfg config.SkillRouterMathConfig) knobParams {
	floatOr := func(v, def float64) float64 {
		if v == 0 {
			return def
		}
		return v
	}
	ptrOr := func(v *float64, def float64) float64 {
		if v == nil {
			return def
		}
		return *v
	}
	return knobParams{
		complexityMu:      floatOr(cfg.ComplexityMu, defaultComplexityMu),
		complexityBias:    ptrOr(cfg.ComplexityBias, defaultComplexityBias),
		costPenaltyBeta:   floatOr(cfg.CostPenaltyBeta, defaultCostPenaltyBeta),
		overPenaltyLambda: floatOr(cfg.OverPenaltyLambda, defaultOverPenaltyLambda),
		preferencePower:   floatOr(cfg.PreferencePower, defaultPreferencePower),
		maxMuMultiplier:   floatOr(cfg.MaxMuMultiplier, defaultMaxMuMultiplier),
		maxBiasShift:      ptrOr(cfg.MaxBiasShift, defaultMaxBiasShift),
		maxCostRelief:     floatOr(cfg.MaxCostRelief, defaultMaxCostRelief),
		maxOverRelief:     floatOr(cfg.MaxOverRelief, defaultMaxOverRelief),
		minMuMultiplier:   floatOr(cfg.MinMuMultiplier, defaultMinMuMultiplier),
		minBiasShift:      ptrOr(cfg.MinBiasShift, defaultMinBiasShift),
		minCostBoost:      floatOr(cfg.MinCostBoost, defaultMinCostBoost),
		minOverBoost:      floatOr(cfg.MinOverBoost, defaultMinOverBoost),
	}
}

// effectiveParams reshapes the base math parameters through the routing
// preference r in [-1,1] using the asymmetric power law from the paper
// (reference: sweep_knob_aggressive.py effective_knob_params):
//
//	pos = max(r,0)^power, neg = max(-r,0)^power
//	mu     = mu0    * exp( pos*ln(maxMuMultiplier) + neg*ln(minMuMultiplier) )
//	bias   = bias0  + pos*maxBiasShift + neg*minBiasShift
//	beta   = beta0  * exp(-pos*ln(maxCostRelief)   + neg*ln(minCostBoost) )
//	lambda = lam0   * exp(-pos*ln(maxOverRelief)   + neg*ln(minOverBoost) )
//
// At r=0 every parameter equals its base. r=+1 maximizes quality (inflated
// requirement, cost and over-capacity nearly free); r=-1 minimizes cost
// (deflated requirement, strong cost and over-capacity pressure).
func effectiveParams(kp knobParams, preference float64) (mu, bias, beta, lambda float64) {
	r := clamp(preference, -1, 1)
	power := kp.preferencePower
	if power <= 0 || math.IsNaN(power) || math.IsInf(power, 0) {
		power = 1.0
	}
	pos := math.Pow(math.Max(r, 0), power)
	neg := math.Pow(math.Max(-r, 0), power)

	mu = kp.complexityMu * math.Exp(pos*math.Log(kp.maxMuMultiplier)+neg*math.Log(kp.minMuMultiplier))
	bias = kp.complexityBias + pos*kp.maxBiasShift + neg*kp.minBiasShift
	beta = kp.costPenaltyBeta * math.Exp(-pos*math.Log(kp.maxCostRelief)+neg*math.Log(kp.minCostBoost))
	lambda = kp.overPenaltyLambda * math.Exp(-pos*math.Log(kp.maxOverRelief)+neg*math.Log(kp.minOverBoost))
	return mu, bias, beta, lambda
}

type capabilityClassifier struct {
	modelPath string
	labels    []string
}

type capabilityResult struct {
	probabilities []float64
	err           error
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
	logging.Infof("[Brick2] initializing capability classifier: %s", modelPath)
	if err := candle.InitModernBertClassifier(modelPath, cfg.UseCPU); err != nil {
		return nil, fmt.Errorf("initialize capability classifier %q: %w", modelPath, err)
	}
	return &capabilityClassifier{modelPath: modelPath, labels: labels}, nil
}

func (c *capabilityClassifier) Classify(text string) ([]float64, error) {
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

// noLogprobWarn gates the "no usable logprobs" warning to once per process.
// It is package-level rather than a complexityClient field because the client
// is not always a long-lived singleton: ClassifyComplexityLabel (the Anthropic
// passthrough model_map fallback) builds a fresh complexityClient per request,
// so a per-instance sync.Once would never have fired and the warning would
// flood the logs on every fallback classification.
var noLogprobWarn sync.Once

type complexityClient struct {
	baseURL           string
	bearerToken       string
	protocol          string
	modelName         string
	defaultConfidence float64
	httpClient        *http.Client
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

	// Expand env references (e.g. "${REGOLO_API_KEY}") so an unexpanded literal
	// does not shadow the ResolveBearerToken fallback below and cause the router
	// to send "Authorization: Bearer ${REGOLO_API_KEY}" verbatim (403 -> every
	// request falls back to "medium").
	token := strings.TrimSpace(os.ExpandEnv(skillCfg.BearerToken))
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

	// Protocol: skill-router value wins, else the ComplexityService value,
	// else "brick" (the legacy custom /classify endpoint).
	protocol := strings.ToLower(strings.TrimSpace(skillCfg.Protocol))
	if protocol == "" && cfg.ComplexityService != nil {
		protocol = strings.ToLower(strings.TrimSpace(cfg.ComplexityService.Protocol))
	}
	if protocol == "" {
		protocol = "brick"
	}

	// ModelName (OpenAI protocol only): skill-router model_name, else its
	// model_id, else the ComplexityService model_name.
	modelName := strings.TrimSpace(skillCfg.ModelName)
	if modelName == "" {
		modelName = strings.TrimSpace(skillCfg.ModelID)
	}
	if modelName == "" && cfg.ComplexityService != nil {
		modelName = strings.TrimSpace(cfg.ComplexityService.ModelName)
	}

	// DefaultConfidence (OpenAI protocol, used only when the endpoint returns no
	// usable logprobs): skill value wins, else ComplexityService, else 0.5.
	defaultConfidence := defaultOpenAINoLogprobConfidence
	if skillCfg.DefaultConfidence != nil {
		defaultConfidence = *skillCfg.DefaultConfidence
	} else if cfg.ComplexityService != nil && cfg.ComplexityService.DefaultConfidence != nil {
		defaultConfidence = *cfg.ComplexityService.DefaultConfidence
	}
	if defaultConfidence < 0 {
		defaultConfidence = 0
	}
	if defaultConfidence > 1 {
		defaultConfidence = 1
	}

	return &complexityClient{
		baseURL:           baseURL,
		bearerToken:       token,
		protocol:          protocol,
		modelName:         modelName,
		defaultConfidence: defaultConfidence,
		httpClient:        &http.Client{Timeout: timeout},
	}
}

// Classify returns the complexity label ("easy"/"medium"/"hard") and a
// confidence in [0,1]. It dispatches on the configured protocol and always
// degrades to ("medium", 1.0) on any transport or decode error so routing
// keeps working when the classifier is unavailable. Wall time of the call is
// recorded into the brick_cc_classify_duration_seconds histogram (success and
// fallback both count), which `brick claude status` reads for avg/p50/p95.
func (c *complexityClient) Classify(ctx context.Context, text string) (string, float64) {
	start := time.Now()
	defer func() { metrics.BrickCCClassifyDuration.WithLabelValues().Observe(time.Since(start).Seconds()) }()
	if c.protocol == "openai" {
		return c.classifyOpenAI(ctx, text)
	}
	return c.classifyBrick(ctx, text)
}

// ClassifyComplexityLabel builds a one-shot complexity classifier from cfg's
// skill-router complexity_model config (with the same fallback to
// complexity_service that the router core uses) and returns just the label
// ("easy"/"medium"/"hard").
//
// It exists so callers outside the router core — notably the Anthropic
// passthrough model_map fallback in pkg/proxy, which runs when the skill router
// did not produce a label — share the exact protocol handling (brick /classify
// vs OpenAI /v1/chat/completions), bearer-token expansion, and model-name
// resolution as the skill router, instead of reimplementing a protocol-blind
// POST /classify. Degrades to "medium" when cfg is nil or the classifier is
// unavailable, so routing keeps working.
func ClassifyComplexityLabel(ctx context.Context, cfg *config.RouterConfig, text string) string {
	if cfg == nil {
		return "medium"
	}
	c := newComplexityClient(cfg, cfg.SkillRouter.ComplexityModel)
	label, _ := c.Classify(ctx, text)
	return label
}

// classifyBrick calls the custom brick-complexity-server POST /classify endpoint
// ({"text":...} -> {"label","confidence"}).
func (c *complexityClient) classifyBrick(ctx context.Context, text string) (string, float64) {
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

// classifyOpenAI calls an OpenAI-compatible POST /v1/chat/completions endpoint.
// It sends the complexity SYSTEM_PROMPT plus the query, reads the label from the
// first completion token, and derives confidence by softmaxing the easy/medium/
// hard token logprobs when the server returns them (else 1.0).
func (c *complexityClient) classifyOpenAI(ctx context.Context, text string) (string, float64) {
	reqBody := map[string]any{
		"model": c.modelName,
		"messages": []map[string]string{
			{"role": "system", "content": complexitySystemPrompt},
			{"role": "user", "content": "Classify: " + text},
		},
		"max_tokens":   1,
		"temperature":  0,
		"logprobs":     true,
		"top_logprobs": 20,
	}
	body, _ := json.Marshal(reqBody)
	url := strings.TrimRight(c.baseURL, "/") + "/v1/chat/completions"
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
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
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
			Logprobs *struct {
				Content []struct {
					Token       string  `json:"token"`
					Logprob     float64 `json:"logprob"`
					TopLogprobs []struct {
						Token   string  `json:"token"`
						Logprob float64 `json:"logprob"`
					} `json:"top_logprobs"`
				} `json:"content"`
			} `json:"logprobs"`
		} `json:"choices"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&decoded); err != nil {
		logging.Warnf("[Brick2] complexity fallback: %v", err)
		return "medium", 1.0
	}
	if len(decoded.Choices) == 0 {
		logging.Warnf("[Brick2] complexity fallback: empty choices")
		return "medium", 1.0
	}

	label := normalizeComplexityLabel(decoded.Choices[0].Message.Content)

	// Confidence from logprobs of the first generated token, when present.
	if lp := decoded.Choices[0].Logprobs; lp != nil && len(lp.Content) > 0 {
		alts := map[string]float64{}
		// Include the chosen token itself plus its alternatives.
		alts[lp.Content[0].Token] = lp.Content[0].Logprob
		for _, t := range lp.Content[0].TopLogprobs {
			if cur, ok := alts[t.Token]; !ok || t.Logprob > cur {
				alts[t.Token] = t.Logprob
			}
		}
		if conf, ok := confidenceFromLogprobs(label, alts); ok {
			return label, conf
		}
	}
	// No usable logprobs: the endpoint did not return per-label token logprobs,
	// so we cannot derive a calibrated confidence. Fall back to the configured
	// default_confidence (default 0.5) instead of assuming full certainty, and
	// warn once so the operator can enable logprobs or tune the default.
	c.noLogprobWarnDo()
	return label, c.defaultConfidence
}

// noLogprobWarnDo emits the "no usable logprobs" warning at most once per
// process (see the package-level noLogprobWarn).
func (c *complexityClient) noLogprobWarnDo() {
	noLogprobWarn.Do(func() {
		logging.Warnf("[Brick2] complexity openai endpoint returned no usable logprobs; "+
			"using default_confidence=%.2f for routing (enable logprobs/top_logprobs on the "+
			"endpoint for calibrated confidence, or set complexity_service.default_confidence)",
			c.defaultConfidence)
	})
}
