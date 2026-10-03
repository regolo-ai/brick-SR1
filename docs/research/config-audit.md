# Brick config.yaml Audit — Condensed English Version

> Source: `brick-config-audit.md` (Italian, 637 lines), full audit of the Brick
> `config.yaml` dated **19 March 2026**.
> This is a condensed English translation. All numbers, parameter names, values,
> and the operational checklist are preserved. Paths that no longer exist are
> explicitly marked **STALE** with the current correct path where known.

---

## 0. Pre-Deploy Operational Checklist

### 0.1 Update repo and check version

```bash
# 1. Go to the project directory
cd /root/forkGO/spatial-routing   # STALE — see note below

# 2. Check current version and repo state
git log --oneline -5
git status
git remote -v

# 3. Fetch and pull latest version from upstream
#    (if your fork tracks upstream vllm-project/spatial-router)
git fetch origin
git pull origin main
#    or, with a separate upstream remote:
git fetch upstream
git merge upstream/main

# 4. If you never added upstream:
git remote add upstream https://github.com/vllm-project/spatial-router.git
git fetch upstream
git merge upstream/main

# 5. Check the binary/CLI version
vllm-sr --version                  # STALE — see note below
#    or, using the Go binary directly:
./vllm-sr version                  # STALE — see note below

# 6. Check the binary supports v0.3 canonical config
vllm-sr config validate --config config.yaml   # STALE — see note below
```text

> **STALE:** `/root/forkGO/spatial-routing` does not exist. Repo root is
> `/root/forkGO`; router code lives in `apps/router/`. Config files:
> `config.yaml` (repo root) and `apps/router/config/config.yaml`.
> **STALE:** `vllm-sr` / `./vllm-sr` binary references (steps 5–6, migrate/serve
> commands below). No such binary exists in this repo; use the equivalent
> command for the current `apps/router/` build.

**WARNING:** if your fork has custom changes (brick handler, etc.), run
`git stash` before merging and resolve conflicts afterwards.

### 0.2 Check local models

The routing models (embedding + domain classifier) are local to the container.
Verify they exist:

```bash
# Embedding models for the complexity signal
ls -la models/mom-embedding-pro/
# Must contain: config.json, model.safetensors (or .bin), tokenizer.json, etc.

# Domain classifier model
ls -la models/mom-domain-classifier/
ls -la models/mom-domain-classifier/category_mapping.json

# Check sizes (the ModernBERT classifier is ~400MB)
du -sh models/mom-domain-classifier/
du -sh models/mom-embedding-pro/
```text

### 0.3 Recommended action sequence (post-audit)

```text
STEP 1: git pull / update to latest version
STEP 2: Backup current config → cp config.yaml config.yaml.backup
STEP 3: Critical fixes (factual errors in config)
         - Fix param_size qwen3-coder-next: "32b" → "80b"
         - Remove reasoning_family: "qwen3" from gpt-oss-120b
         - Remove or assign gpt-oss-120b and Llama-3.3-70B-Instruct
         - Remove unused language_rules and context_rules (or create decisions)
STEP 4: Verify GPT-OSS harmony-format compatibility on Regolo
         - Test: curl https://api.regolo.ai/v1/chat/completions with gpt-oss-20b
         - Verify the response format is correct
STEP 5: Routing optimizations
         - Move math_reasoning → qwen3.5-122b with use_reasoning: true
         - Collapse 3 code-complexity decisions into one
         - Simplify formatting_tasks
STEP 6: Test complexity signal (see section 0.4)
STEP 7: Evaluate migration to v0.3 canonical
         - vllm-sr config migrate --config config.yaml   # STALE binary; command shape preserved
         - Diff and review the result
STEP 8: Add plugins (system_prompt, jailbreak, pii) if production
STEP 9: End-to-end test with sample queries for each decision
```text

### 0.4 Deep dive: does the complexity signal work?

Verified against the official docs at vllm-spatial-router.com (Latest).
**Answer: `type: complexity` is officially supported in decisions.**
Reference examples: Composite Decisions
(`https://vllm-spatial-router.com/docs/tutorials/decision/composite`) uses
`type: complexity` with `name: needs_reasoning` inside an OR branch;
Complexity Signal
(`https://vllm-spatial-router.com/docs/tutorials/signal/learned/complexity`)
configures it as `routing.signals.complexity` with `name: needs_reasoning`,
`threshold: 0.75`, `description`, `hard.candidates[]` (e.g. "solve this step
by step", "compare multiple tradeoffs", "analyze the root cause") and
`easy.candidates[]` (e.g. "answer briefly", "quick summary", "simple rewrite").

**Four differences between the official docs and this config:**

1. **Difficulty-level reference.** Official: signal `needs_reasoning`,
   decision condition `name: needs_reasoning`, NO level suffix. This config:
   signal `reasoning-complexity`, condition `name: "reasoning-complexity:hard"`
   with `:hard` / `:medium` / `:easy` suffixes. That suffix syntax does NOT
   appear in the official docs — possible fork feature, undocumented feature,
   or silent mismatch (condition never matches).
2. **Only `hard` + `easy`, no `medium`.** The official example has only `hard:`
   and `easy:` candidates. This config also defines `medium:` — possibly
   supported-but-undocumented, silently ignored, or a fork feature.
3. **Legacy vs v0.3 format.** Official (Latest) placement is
   `routing.signals.complexity`; this config uses top-level `complexity_rules`.
   If the fork still supports the legacy format, fine; if the parser expects
   `routing.signals.complexity`, the rules never load.
4. **Very different threshold.** Official: `0.75`. This config: `0.10` — very
   low, likely many false positives (easy queries classified hard) or unstable
   classification.

**How to verify empirically:**

```bash
# 1. Start the router in debug/verbose mode
RUST_LOG=debug vllm-sr serve --config config.yaml   # STALE binary; command shape preserved
# or (Go binary):
LOG_LEVEL=debug ./vllm-sr --config config.yaml      # STALE binary; command shape preserved

# 2. In another terminal, send test queries per level and inspect headers
# EASY query (should match easy_reasoning → qwen3.5-9b):
curl -s http://localhost:8000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $REGOLO_API_KEY" \
  -d '{"model":"brick","messages":[{"role":"user","content":"What is the capital of France?"}]}'
# Response headers must show: x-selected-model: qwen3.5-9b
# (inspect via curl -sv ... 2>&1 | grep -i "x-selected-model\|x-routing")

# HARD reasoning query (must show x-selected-model: qwen3.5-122b):
# content: "Analyze the geopolitical implications of renewable energy adoption
#   on OPEC nations and derive a game-theoretic framework for their strategic response"

# HARD code query (must show x-selected-model: qwen3-coder-next):
# content: "Implement a distributed lock manager with leader election and failover in Rust"

# 3. Confirm via Prometheus metrics
curl -s http://localhost:9190/metrics | grep -i "routing\|reasoning\|classification"
```text

**Plan B if it does not work:** convert complexity rules to the fully
documented embedding-signal format — Option A: `routing.signals.embeddings`
entries (e.g. `hard_reasoning_queries`, `threshold: 0.75`,
`aggregation_method: "max"`; `easy_factual_queries`, `threshold: 0.72`) with
decisions of `type: "embedding"`; Option B: complexity signal in official shape
(`complexity: [{name: reasoning_difficulty, threshold: 0.75, hard:, easy:}]`)
referenced WITHOUT the `:hard` suffix
(`type: "complexity", name: "reasoning_difficulty"` → model `qwen3.5-122b`,
`use_reasoning: true`, `priority: 101`).

---

## 1. Structural Validation vs Official Documentation

### 1.1 Legacy flat format vs v0.3 canonical (CRITICAL)

The config uses the **legacy flat** (pre-v0.3) format, NOT v0.3 canonical
(`version: / listeners: / providers: / routing: / global:`). It uses legacy
top-level keys: `keyword_rules`, `complexity_rules`, `model_config`,
`vllm_endpoints`, `provider_profiles`, `decisions`, `categories`, `classifier`,
`embedding_models`, etc.

Migration map: `keyword_rules` → `routing.signals.keywords`;
`complexity_rules` → `routing.signals.complexity`;
`categories` + `classifier` → `routing.signals.domain` +
`global.model_catalog.modules.classifier`; `decisions` → `routing.decisions`;
`model_config` → `routing.modelCards` (semantics) + `providers.models`
(deployment binding); `vllm_endpoints` + `provider_profiles` →
`providers.models[].backend_refs[]`; `default_model` + `reasoning_families` +
`default_reasoning_effort` → `providers.defaults`; `embedding_models` →
`global.model_catalog.embeddings`.

**Severity: medium-high** — the v0.1 parser accepts legacy (same top-level
keys as official v0.1 snippets), but the Latest/v0.3 canonical parser accepts
ONLY the new format. Check `vllm-sr --version` (STALE binary — see §0.1):
on v0.1 the config is structurally valid; on v0.3+ it must be migrated
(`vllm-sr config migrate --config config.yaml`, STALE binary).

### 1.2 Keyword signals

OK: `name` / `operator` / `keywords` / `case_sensitive` correct; `OR` valid;
EN+IT bilingualism is good practice; having no "easy_questions" rule wisely
avoids misrouting.
Issues: (a) missing `method` — docs support `method: bm25` and
`method: ngram`; without it the router uses exact match, which fails
multi-word keywords ("difference between", "chain of thought", "write a",
"differenza tra") unless the phrase appears verbatim — consider
`method: ngram` with `ngram_threshold: 0.4`; (b) over-generic keywords:
`"class"` (code), `"character"` (creative), `"reason"` (reasoning), `"story"`
match unrelated queries — use more specific phrases or `method: bm25`;
(c) rule overlap: "analyze this code" matches both `code_keywords` and
`analysis_keywords` (priority cascade 170 > 130 resolves to coding, usually
right), but "compare these algorithms" matches `analysis_keywords` (130) on
"compare" before the CS domain classifier, routing to `mistral-small-4-119b`
instead of the coder — consider moving "compare"/"evaluate" out of analysis
when combined with CS context.

### 1.3 Complexity signals

OK: `hard` / `medium` / `easy` + `candidates` structure per docs;
`threshold: 0.10` reasonable for embedding separation; 100+ candidates per rule
is excellent coverage; the `composer` on `code-complexity` (domain + keyword)
is a correct advanced pattern.
Issues: (a) missing `description` on `reasoning-complexity` (present on
`code-complexity`); (b) redundancy: `hard_code` / `medium_code` / `easy_code`
(priorities 120/115/110) ALL route to `qwen3-coder-next` with
`use_reasoning: false` — collapse into one decision with OR conditions.

### 1.4 Domain classifier

OK: 14 standard MMLU categories; `threshold: 0.45` reasonable; local path
`models/mom-domain-classifier` with `use_modernbert: true` conforms;
`category_mapping_path` specified. Note: in v0.3 the classifier belongs under
`global.model_catalog.modules.classifier`, not top-level `classifier`.

### 1.5 Language and context rules — DEAD CONFIG

`language_rules` (en, it, zh) and `context_rules` (short_context,
long_context) are declared but referenced by NO decision. Either create
decisions using them or remove them.

### 1.6 Decisions

OK: priority cascade (200→98) keyword > complexity > domain > default;
`rules.operator` + `conditions` + `modelRefs` correct; `use_reasoning`
handled correctly; keyword → complexity → domain separation is sound.
Issues: (a) `formatting_tasks` uses `algorithm.type: "confidence"` with 2
modelRefs (`mistral-small3.2`, `mistral-small-4-119b`,
`confidence_method: "margin"`, `threshold: 0.5`) — in v0.3 algorithms belong
under `decision.algorithm`; verify fork support; (b) top-level
`strategy: "priority"` is legacy (implicit in v0.3); (c) duplicate complexity
decisions (see §1.3); (d) no plugins — docs support semantic-cache,
jailbreak, PII, system_prompt, hallucination; evaluate at least `jailbreak`
and `pii` for production.

### 1.7 Providers and endpoints

OK: Regolo provider `type: openai`, `base_url: https://api.regolo.ai/v1`
correct for an OpenAI-compatible backend; API key via `${REGOLO_API_KEY}` is
best practice.
Issues: (a) duplication — `providers.regoloai` (brick handler) plus
`provider_profiles.regolo` + `vllm_endpoints` (routing); in v0.3 all goes
under `providers.models[]` with `backend_refs[]`; (b) single endpoint with
weight 1 — no load balancing (fine for one endpoint; use multi-backend with
weights if Regolo has several regions/endpoints).

### 1.8 Brick multimodal gateway (fork-custom, non-standard)

STT → OCR → Vision pipeline is well designed; `ocr_min_text_length: 10` is a
sensible OCR-vs-vision threshold; per-modality models appropriate. Note: the
`brick:` section is fork-custom, not standard vLLM-SR docs — test all three
paths (audio → STT → text routing; image+short text → OCR → text routing;
image → vision).

### 1.9 Embedding models config (fork-specific)

`embedding_models` with HNSW config and `qwen3_model_path` is fork-specific;
v0.3 canonical places it under `global.model_catalog.embeddings`.
`preload_embeddings`, `enable_soft_matching`, `min_score_threshold` look like
custom HNSW options, non-standard in public docs.

---

## 2. Model-by-Model Analysis

### 2.1 qwen3.5-9b

**Routes:**→ `simple_chat` + `easy_reasoning` — EXCELLENT

Beats GPT-OSS-120B (a 13x larger model) on GPQA Diamond (81.7 vs 71.5) and
MMMU-Pro (70.1 vs 59.7). Oversized for greetings/trivia but the cheapest
model in the fleet, so correct; latency minimal. Suggestion: also use it for
`formatting_tasks` instead of `mistral-small3.2` — capable and cheaper.

### 2.2 gpt-oss-20b

**Routes:**→ `default_model` + `domain_business` + `domain_general` — GOOD WITH RESERVES

OpenAI MoE (21B total, 3.6B active/token), configurable reasoning, ~o3-mini
class. Great fast/cheap default. Issues: (a) **harmony response format** —
GPT-OSS was trained on OpenAI's "harmony" format and works correctly ONLY
with it; if Regolo does not apply the harmony chat template automatically,
output degrades — **verify the Regolo endpoint template**; (b) adequate for
business/economics but not specialized (Mistral Small 4 119B better for
complex economic analysis). Fallback: if harmony is unsupported, replace the
default with `qwen3.5-9b` or `mistral-small3.2`.

### 2.3 gpt-oss-120b

**Routes:**→ referenced by NO decision — DECLARED BUT UNUSED

In `model_config` with `param_size: "120b"` but no decision references it:
dead config. Additional errors: `reasoning_family: "qwen3"` is WRONG —
GPT-OSS uses its own reasoning system (harmony format, reasoning_effort
low/medium/high), NOT Qwen3 `enable_thinking`; would break if ever used with
`use_reasoning: true`. (117B total, 5.1B active MoE; excellent for STEM/general
reasoning if used.) Action: remove, or create a decision with the correct
reasoning family.

### 2.4 qwen3-coder-next

**Routes:**→ `coding_tasks` + `math_reasoning` + `hard/medium/easy_code` + `domain_cs` — EXCELLENT FOR CODE, QUESTIONABLE FOR MATH

MoE (80B total, 3B active) trained for coding agents; ~Sonnet 4.5 on coding,
44.3% on SWE-Bench Pro. The right model for all code decisions. Issues:
(a) **`param_size: "32b"` is WRONG** — fix to `"80b"` (or "3b-active");
(b) suboptimal for `math_reasoning` — trained on coding/agent tasks, not math
reasoning; for proofs/calculus/abstract algebra prefer `qwen3.5-122b` with
`use_reasoning: true` (keep the coder for code-adjacent math);
(c) `use_reasoning: false` on `math_reasoning` — thinking mode materially
helps hard math; set `true`, or split computational math (coder) vs
theoretical math (qwen3.5-122b + reasoning).

### 2.5 Llama-3.3-70B-Instruct

**Routes:**→ UNUSED — DECLARED BUT UNUSED

In `model_config`, referenced by no decision: dead config. Solid versatile
model but redundant here (Mistral Small 4 119B covers humanities/creative,
Qwen3.5-122B covers STEM/reasoning). Action: remove or assign (e.g.
`domain_business` / `domain_humanities` as lighter Mistral Small 4
alternative).

### 2.6 mistral-small3.2

**Routes:**→ `formatting_tasks` (primary, confidence fallback to mistral-small-4-119b) — ACCEPTABLE BUT UNDERUSED

Dense 24B, good instruction following/formatting, but oversized for
formatting (`qwen3.5-9b` does it cheaper) and a 24B-vs-119B confidence
algorithm just to capitalize text is overkill — one model suffices. Unused
elsewhere; if kept, give it more work (e.g. fast instruct for medium general
queries).

### 2.7 mistral-small-4-119b

**Routes:**→ `creative_writing` + `analysis_medium` + `domain_humanities` + `medium_reasoning` + `formatting_tasks` (fallback) — EXCELLENT

Released 16 March 2026 — 119B MoE, 128 experts, 4 active/token (~6B active);
unified instruct/reasoning/multimodal; beats GPT-OSS-120B on LiveCodeBench
and AA-LCR with 20% shorter outputs; configurable reasoning_effort. Strong
fit: creative (historically strong in French/Italian/European languages),
analysis (concise: 1.6K vs 5.8K chars for Qwen on AA-LCR), humanities,
scalable medium reasoning. Gaps: no `reasoning_family` declared — it uses
Mistral's system (`reasoning_effort: none/low/medium/high`), NOT Qwen3
`enable_thinking`; harmless today (all its decisions use
`use_reasoning: false`) but must be added as `reasoning_family: "mistral"`
before any `use_reasoning: true` use. `param_size: "119b"` is correct as total
but misleading for cost/latency estimates (~6B active).

### 2.8 qwen3.5-122b

**Routes:**→ `deep_reasoning` + `domain_stem` + `domain_science` + `hard_reasoning` — EXCELLENT, FLEET TANK

Most powerful in fleet: MoE 122B total / 10B active; score 42 on Artificial
Analysis Intelligence Index; BFCL-V4 tool use 72.2 (beats GPT-5 mini),
BrowseComp 63.8, MathVision 88.6 (beats GPT-5.2); 201 languages, 262K context,
vision. `reasoning_family: "qwen3"` with `parameter: "enable_thinking"` is
CORRECT. Suggestions: also use for `math_reasoning` (over qwen3-coder-next)
with `use_reasoning: true`; `domain_stem` currently `use_reasoning: false` —
enable reasoning for STEM (at least medium/hard).

---

## 3. Synthesis and Recommendations

### Critical issues (fix immediately)

| # | Issue | Action |
|---|-------|--------|
| 1 | Legacy format, not v0.3 | `vllm-sr config migrate` (STALE binary — see §0.1) |
| 2 | `gpt-oss-120b` and `Llama-3.3-70B-Instruct` declared but unused | Remove or assign decisions |
| 3 | `gpt-oss-120b` has WRONG `reasoning_family: "qwen3"` | Fix or remove |
| 4 | `qwen3-coder-next` has WRONG `param_size: "32b"` (is 80B/3B-active) | Fix to "80b" |
| 5 | `language_rules` and `context_rules` declared but unused | Remove or create decisions |
| 6 | GPT-OSS harmony format vs Regolo — potential incompatibility | Verify chat template |

### Recommended optimizations

| # | Optimization | Impact |
|---|--------------|--------|
| 1 | Move `math_reasoning` → `qwen3.5-122b` with `use_reasoning: true` | Math quality ↑ |
| 2 | Collapse `hard_code` + `medium_code` + `easy_code` into one decision | Cleaner config |
| 3 | Enable reasoning on `domain_stem` (at least hard STEM) | STEM quality ↑ |
| 4 | Add `jailbreak` and `pii` plugins for production | Security ↑ |
| 5 | Simplify `formatting_tasks`: single model, drop confidence algorithm | Complexity ↓ |
| 6 | Add `method: bm25` or `ngram` for multi-word keywords | Match precision ↑ |
| 7 | Use `context_rules` for long-context routing → 256K models (Qwen3.5, Mistral Small 4) | Avoids context errors |

### Suggested final model map

```text
Greetings/Trivial → qwen3.5-9b (use_reasoning: false)        confirmed
Formatting        → qwen3.5-9b (use_reasoning: false)        changed (was mistral-small3.2)
Code (all)        → qwen3-coder-next (use_reasoning: false)  confirmed
Math              → qwen3.5-122b (use_reasoning: true)       changed (was qwen3-coder-next)
Creative          → mistral-small-4-119b (use_reasoning: false) confirmed
Analysis          → mistral-small-4-119b (use_reasoning: false) confirmed
Deep reasoning    → qwen3.5-122b (use_reasoning: true)       confirmed
STEM hard         → qwen3.5-122b (use_reasoning: true)       reasoning enabled
Humanities        → mistral-small-4-119b (use_reasoning: false) confirmed
Business/General  → gpt-oss-20b (use_reasoning: false)       confirmed (verify harmony)
Life sciences     → qwen3.5-122b (use_reasoning: false)      confirmed
Default           → gpt-oss-20b                              confirmed
```text

Models to remove if unused: `gpt-oss-120b`, `Llama-3.3-70B-Instruct`,
potentially `mistral-small3.2` (replaced by qwen3.5-9b for formatting).

---

## Appendix: doc-verification results

Confirmed valid: decisions structure (name/priority/rules/modelRefs);
nested OR/AND operators; `type: "keyword"` → `keyword_rules`;
`type: "domain"` → `categories`; classifier with `use_modernbert` +
`category_mapping_path`; `categories` with `mmlu_categories`;
`model_config` + `vllm_endpoints` + `provider_profiles` (valid for v0.1);
per-decision `reasoning_effort` (supported, unused here); inline decision
plugins (supported, unused here — recommended); `default_model` fallback.

Not confirmed / doubtful: `type: "complexity"` in conditions — CONFIRMED via
official Composite Decisions doc; `name: "code-complexity:hard"`
(`:hard` suffix) — NOT FOUND (official uses bare signal name);
`medium:` bucket — UNDOCUMENTED (official: only `hard:` + `easy:`);
top-level `complexity_rules` — LEGACY (v0.3: `routing.signals.complexity`);
`composer` in complexity_rules — NOT FOUND (possible fork feature);
`algorithm.type: "confidence"` inline — NOT FOUND (v0.3: under
`decision.algorithm`); `brick:` multimodal section — NON-STANDARD (fork
custom); top-level `strategy: "priority"` — LEGACY (implicit in v0.3);
`hnsw_config` in embedding_models — NOT FOUND (possible fork feature).

**Conclusion:** the base structure (keyword → domain → decisions → modelRefs)
is solid and conformant, and `type: complexity` is officially supported.
But the specific syntax — `:hard`/`:medium`/`:easy` suffixes in `name`, the
`medium:` bucket, and `composer` — has no public-docs counterpart; the
official example references the complexity signal by bare name only. **The
empirical test (§0.4) remains the only way to confirm the exact syntax works.**
