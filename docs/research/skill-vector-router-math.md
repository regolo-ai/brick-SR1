# Skill-Vector Router Math (6D)

> Source: consolidated English translation and synthesis of `/root/forkGO/router_skill_vector_math.md` (583 lines, Italian, mathematical know-how of the 6D skill-vector router) and `/root/forkGO/script.md` (90 lines, English narrative draft on superficial vs capability routing).
> Date: 2026-10-01.
> Originals preserved: both source files were NOT deleted or modified.
> Scope: preserves all mathematics from the Italian source; incorporates the narrative reasoning from `script.md` where pertinent; flags known discrepancies versus paper / implementation.

## 1. Objective: capability routing, not superficial routing

The goal is a mathematical rule that lets the router pick the best model for a query using three inputs:

1. empirical model performance on an evaluation database;
2. the query capability vector extracted by ModernBERT;
3. the query complexity extracted by the Brick model.

Principle:

```text
model -> 6D skill vector
query -> 6D requirement vector
router -> picks the model closest to the query
```

The space has six dimensions, one per capability:

```text
coding
creative_synthesis
instruction_following
math_reasoning
planning_agentic
world_knowledge
```

Each model becomes a point in skill space. Each query becomes a point in the same space. The selected model is the one best positioned for the query.

### 1.1 Why not superficial routing

Deciding which LLM is best for a task is an empirical process: the only way to discover a particular talent of a model for a specific task type is testing, testing, and testing again.

Other routing systems use:

- coarse domains (science, math, humanities, economics, ...), or
- query length plus keyword/regex matching on the payload.

That is called here **superficial routing**. It is insufficient because real models must be judged on very different capability types. If a coding agent knows only that a query domain is "computer science", that does not decide between a large pool of models.

Context length is not the answer either: a 10-line question asking for a calculator in Python can be trivial, while a 1-line query asking to solve the Riemann hypothesis can be extremely hard.

This router therefore uses **capability routing**: direction from a capability classifier plus distance from a complexity estimator, matched against empirical per-capability model skills.

## 2. Model skill vectors

For each model `m` and each capability `c`, start from empirical results:

```text
K_m,c = number of correct answers of model m on capability c
N_m,c = total number of evaluated questions for model m on capability c
```

The naive estimate would be:

```text
accuracy_m,c = K_m,c / N_m,c
```

But this estimate is unstable when the example count is small. Therefore use a Bayesian smoothed estimate:

```text
a_m,c = (K_m,c + k * mu_c) / (N_m,c + k)
```

where:

```text
a_m,c = estimated skill of model m on capability c
mu_c  = global mean accuracy on capability c
k     = prior strength
```

Recommended value:

```text
k = 8
```

Global capability mean:

```text
mu_c = sum_m K_m,c / sum_m N_m,c
```

Hence the model skill vector is:

```text
A_m = [
  a_m,coding,
  a_m,creative_synthesis,
  a_m,instruction_following,
  a_m,math_reasoning,
  a_m,planning_agentic,
  a_m,world_knowledge
]
```

`None` answers, errors, timeouts, truncations, or incomplete answers must count as incorrect:

```text
K_m,c = correct_true
N_m,c = correct_true + correct_false + correct_none
```

This makes the score more realistic for the router: a model that does not complete an answer must not be considered reliable.

## 3. Query capability vector

The ModernBERT capability classifier returns a probability distribution over the six capabilities:

```text
P = [p_1, p_2, p_3, p_4, p_5, p_6]
```

where:

```text
p_c >= 0
sum_c p_c = 1
```

Example:

```text
P = [0.70, 0.02, 0.05, 0.15, 0.06, 0.02]
```

Interpretation:

```text
70% coding
15% math_reasoning
6% planning_agentic
5% instruction_following
2% creative_synthesis
2% world_knowledge
```

ModernBERT therefore determines the direction of the query in 6D space.

## 4. Query complexity

The complexity extractor returns:

```text
label in {easy, medium, hard}
confidence in [0, 1]
```

Associate each complexity level with a minimum required skill threshold:

```text
tau_easy   = 0.55
tau_medium = 0.72
tau_hard   = 0.88
```

Hence:

```text
tau(label) =
  0.55 if label = easy
  0.72 if label = medium
  0.88 if label = hard
```

To avoid over-trusting the complexity classifier when confidence is low, always interpolate toward `medium`:

```text
tau_query = confidence * tau(label) + (1 - confidence) * tau_medium
```

Example:

```text
label = hard
confidence = 0.80

tau_query = 0.80 * 0.88 + 0.20 * 0.72
tau_query = 0.848
```

Complexity therefore determines the length of the query vector.

```text
ModernBERT says "in which direction to go".
Brick complexity says "how far to go".
```

## 5. Final query vector

The final query vector combines capability and complexity:

```text
q_c = p_c * tau_query
```

i.e.:

```text
Q = tau_query * P
```

Example:

```text
P = [0.70, 0.02, 0.05, 0.15, 0.06, 0.02]
tau_query = 0.848

Q = [
  0.5936,
  0.01696,
  0.0424,
  0.1272,
  0.05088,
  0.01696
]
```

This query requires mostly coding competence, a share of math reasoning, and little competence in the other capabilities.

## 6. Logit transform and logit lift

Accuracies lie in `[0, 1]`. To compare them better, map them to logit space:

```text
logit(x) = ln(x / (1 - x))
```

First apply numeric clamping:

```text
clip(x) = min(max(x, 0.02), 0.98)
```

This avoids infinite values when a skill is too close to 0 or 1.

Model skill in logit space:

```text
S_m,c = logit(clip(a_m,c))
```

Query requirement in logit space:

```text
R_c = p_c * logit(clip(tau_query))
```

The model is weighted in the same query direction:

```text
V_m,c = p_c * S_m,c
```

So compare:

```text
R_c   = p_c * logit(clip(tau_query))
V_m,c = p_c * logit(clip(a_m,c))
```

### Logit lift (implementation form)

The implementation generalizes the query-side logit with an affine lift:

```text
z_q = bias + mu * logit(clip(tau_query))
R_c = p_c * z_q
```

where `bias` and `mu` are router config parameters. With `bias = 0` and `mu = 1` this reduces exactly to the base formula above. Any nonzero `bias` or `mu != 1` shifts/scales difficulty in log-odds space relative to the Italian source (see Section 15).

## 7. Asymmetric distance D_m

A plain Euclidean distance would penalize equally:

```text
model too weak
model too strong
```

But for the router they are not equivalent. A too-weak model is a serious problem. A too-strong model is only overkill. Therefore use an asymmetric distance.

Per capability, define asymmetric residuals:

```text
under_m,c = max(0, R_c - V_m,c)
over_m,c  = max(0, V_m,c - R_c)
```

The final distance is:

```text
D_m = sqrt(
  sum_c under_m,c^2
  +
  lambda * sum_c over_m,c^2
)
```

Recommended value:

```text
lambda = 0.05
```

Interpretation:

```text
under-skill -> full penalty
over-skill  -> light penalty
```

Thus the router prefers a sufficiently capable model but does not punish too strongly the fact that it is stronger than necessary.

## 8. Cost-penalized objective J_m

The quality-first selection uses `D_m`. A future / optional cost-aware variant adds cost directly to the score:

```text
J_m = D_m + beta * a_m
Score_m = D_m + beta * normalized_cost_m
```

where in this notation `a_m` / `normalized_cost_m` is the model normalized cost (`cost_weight`, possibly dynamic from the pricing table), not a skill value.

Recommended settings:

```text
beta = 0.00 -> pure quality
beta = 0.05 -> light cost
beta = 0.20 -> aggressive cost
```

In the current quality-first version:

```text
beta = 0
```

Hence:

```text
cost = tie-breaker only
```

## 9. Model selection

The selected model is the one with minimum distance:

```text
m* = argmin_m D_m
```

In practice:

```text
selected_model = model with minimum distance from the query
```

With cost enabled, replace `D_m` by `J_m`:

```text
m* = argmin_m J_m
```

## 10. Tie-breaker with tie_epsilon

If two models have almost equal score:

```text
abs(D_i - D_j) < epsilon
abs(J_i - J_j) < tie_epsilon
```

use:

```text
epsilon = tie_epsilon = 0.03
```

as the near-tie threshold.

In that case compute expected success (quality proxy):

```text
E_m = sum_c p_c * a_m,c
```

and choose:

```text
m* = argmax_m E_m
```

If expected success is also very close, use the cheaper or faster model. In the quality-first version cost does not enter the main score. Cost enters only as the final tie-breaker.

## 11. Complete formula

Model profile:

```text
a_m,c = (K_m,c + k * mu_c) / (N_m,c + k)
```

Query capability:

```text
P = ModernBERT(query)
```

Query complexity:

```text
label, confidence = ComplexityExtractor(query)
tau_query = confidence * tau(label) + (1 - confidence) * tau_medium
```

Transform:

```text
R_c   = p_c * logit(clip(tau_query))
V_m,c = p_c * logit(clip(a_m,c))
```

Distance:

```text
D_m = sqrt(
  sum_c max(0, R_c - V_m,c)^2
  +
  lambda * sum_c max(0, V_m,c - R_c)^2
)
```

Cost-penalized objective:

```text
J_m = D_m + beta * normalized_cost_m
```

Routing:

```text
selected_model = argmin_m D_m        (quality-first)
selected_model = argmin_m J_m        (cost-aware)
```

Tie-breaker:

```text
E_m = sum_c p_c * a_m,c
```

## 12. Recommended final formula and defaults

The final router formula is:

```text
selected_model =
argmin_m sqrt(
  sum_c max(0, p_c * logit(tau_query) - p_c * logit(a_m,c))^2
  +
  0.05 * sum_c max(0, p_c * logit(a_m,c) - p_c * logit(tau_query))^2
)
```

with:

```text
a_m,c = (K_m,c + 8 * mu_c) / (N_m,c + 8)

tau_query = confidence * tau(label) + (1 - confidence) * 0.72

tau_easy   = 0.55
tau_medium = 0.72
tau_hard   = 0.88

lambda      = 0.05
tie_epsilon = 0.03
beta        = 0 (quality-first)
clip        = [0.02, 0.98]
```

## 13. Geometric interpretation

Each model is a point in skill space. Each query is a point in the same space.

The capability classifier decides the query direction:

```text
coding vs math vs planning vs creative vs instruction vs knowledge
```

The complexity extractor decides how far the query is from the origin:

```text
easy   -> low requirement
medium -> medium requirement
hard   -> high requirement
```

The router picks the nearest model, using an asymmetric distance that prefers capable models over under-sized ones.

For visualization, the draft suggests a 3D projection with model vectors and a nearby query vector; the full math remains 6D.

## 14. Synthetic example

Three models:

```text
small  = [0.70, 0.55, 0.75, 0.62, 0.50, 0.45]
medium = [0.82, 0.70, 0.84, 0.78, 0.68, 0.62]
large  = [0.93, 0.86, 0.91, 0.90, 0.82, 0.78]
```

Query:

```text
P = [0.75, 0.02, 0.05, 0.15, 0.02, 0.01]
label = hard
confidence = 0.90
```

Complexity:

```text
tau_query = 0.90 * 0.88 + 0.10 * 0.72
tau_query = 0.864
```

The query requires high skill mostly in:

```text
coding
math_reasoning
```

The `small` model is penalized because it is below threshold. The `medium` model may be close but could still be insufficient. The `large` model is selected if it is closest under the asymmetric distance.

## 15. Empirical grounding from the narrative draft

The draft grounds the math in an evaluation protocol:

- 3 models from different labs and sizes: `qwen3.5-9b` (SOTA for <10B params), `deepseek-v4-flash` (SOTA for <500B), `kimi-2.6` (frontier open-source).
- Custom evaluation dataset of 5000 questions, partly taken from other datasets and partly human+synthetic (description marked TODO in the draft).
- Correct answers aggregated into `https://huggingface.co/datasets/massaindustries/dataset-A-routing`.
- Router evaluation: each router receives all eval queries and outputs the first chosen model for that task. The correct router answer is defined as the cheapest model that solved that question, without overkill or underestimation.

Reported router-eval snapshot (verbatim from draft):

```text
router,accuracy,avg_cost_per_query,dist
RouteLLM binary,0.21311773255813954,0.9996620639534882,"{'kimi': 5502, 'qwen': 2}"
RouteLLM tournament,0.21311773255813954,0.9996620639534882,"{'kimi': 5502, 'qwen': 2}"
FrugalGPT cascade,0.6317223837209303,0.07000000000000002,{'qwen': 5504}
Cascade Routing,0.28960755813953487,0.5256667877906978,"{'ds4': 3341, 'kimi': 1152, 'qwen': 1011}"
always_qwen,0.6317223837209303,0.07000000000000002,{'qwen': 5504}
always_ds4,0.1555232558139535,0.5,{'ds4': 5504}
always_kimi,0.21275436046511628,1.0,{'kimi': 5504}
oracle,1.0,0.3347365552325582,"{'qwen': 3477, 'kimi': 1171, 'ds4': 856}"
```

The draft notes that discussion of competing algorithms, price/cost-saving graphs, ModernBERT training details (weights and biases images, DB link, hyperparameters), custom difficulty model HF page, latency paragraph, and "why this is cool" framing were still TODO.

## 16. Properties of the logic

This logic has important properties:

1. it is interpretable;
2. it needs no end-to-end training;
3. it can be updated when new evaluations arrive;
4. it separates model skill, query type, and complexity;
5. it allows simple debugging;
6. it avoids hardcoded rules for every route;
7. it generalizes to new models as soon as they are evaluated;
8. it allows future addition of cost, latency, or context constraints.

Pipeline framing from the draft:

```text
1 query
2 keywords
3 ModernBERT capability classifier
4 custom difficulty / complexity model
5 mathematical routing decision
6 visualization
```

## 17. Known discrepancies versus paper / implementation

1. Tie band location: the request flags `router.go:241-246`. In the current checkout the tie logic lives in `scoreModelsWithConfig` / sort comparator (`router.go:324-332`): if `abs(Score_i - Score_j) < tieEps`, compare `ExpectedSuccess`, then cheapest tie cost. Any paper text citing lines 241-246 is stale relative to the current file layout; the semantics (epsilon band then quality proxy then cost) are unchanged.
2. Quality-proxy vs oracle: the router tie-breaker `E_m = sum_c p_c * a_m,c` is only a quality proxy. It is not the eval oracle from Section 15 (cheapest model that actually solved the question, accuracy 1.0 by construction). Do not present `E_m` as oracle performance.
3. Logit lift: the implementation uses `z_q = bias + mu * logit(tau_query)` before multiplying by `p_c`. The Italian source has no `bias`/`mu`. Results coincide only for `bias = 0, mu = 1`.
4. Cost objective: the Italian source sets `beta = 0` (cost as tie-breaker only). The implementation supports `J_m = D_m + beta * cost_weight` with dynamic pricing-table weights, so cost-aware runs diverge from the quality-first formula.
5. Keyword path: the implementation has a keyword-override / keyword-bias path that bypasses or shifts the skill-vector score. That path is outside the pure `D_m` / `J_m` math preserved above.

## 18. Final mathematical decision procedure

Recommended mathematical configuration:

```text
skill estimator = Bayesian score
query space     = 6D scaled
distance        = weighted asymmetric
objective       = quality-first
cost            = tie-breaker
```

Final rule:

```text
1. compute model skills A_m with Bayesian smoothing
2. extract P from the query with ModernBERT
3. extract tau_query with Brick complexity
4. map model and query to logit space
5. compute asymmetric distance D_m
6. choose argmin_m D_m (or argmin_m J_m if cost-aware)
7. use expected success and cost only as tie-breakers
```
