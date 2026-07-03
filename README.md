<div align="center">

# 🧱 Brick

### One OpenAI-compatible endpoint. The right model for every query.

Brick is a **Mixture-of-Models (MoM) routing gateway**. It reads each prompt's
**capability** and **complexity**, then routes it to the best backend in a pool of
open- and closed-weight LLMs, matching the strongest single model's quality at a
fraction of its cost. No cascades. No wasted calls. Drop-in `model: "brick"`.

[![CI](https://img.shields.io/github/actions/workflow/status/regolo-ai/brick-SR1/ci.yml?branch=main&style=flat-square&logo=githubactions&logoColor=white&label=CI)](https://github.com/regolo-ai/brick-SR1/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache%202.0-blue?style=flat-square)](LICENSE)
[![Last commit](https://img.shields.io/github/last-commit/regolo-ai/brick-SR1?style=flat-square&logo=git&logoColor=white)](https://github.com/regolo-ai/brick-SR1/commits)
[![Stars](https://img.shields.io/github/stars/regolo-ai/brick-SR1?style=flat-square&logo=github)](https://github.com/regolo-ai/brick-SR1/stargazers)
[![Issues](https://img.shields.io/github/issues/regolo-ai/brick-SR1?style=flat-square&logo=github)](https://github.com/regolo-ai/brick-SR1/issues)

[![Go](https://img.shields.io/badge/Go-1.24-00ADD8?style=flat-square&logo=go&logoColor=white)](https://go.dev)
[![Rust](https://img.shields.io/badge/Rust-1.90-000000?style=flat-square&logo=rust&logoColor=white)](https://www.rust-lang.org)
[![Python](https://img.shields.io/badge/Python-3.10+-3776AB?style=flat-square&logo=python&logoColor=white)](https://www.python.org)
[![OpenAI compatible](https://img.shields.io/badge/API-OpenAI%20compatible-412991?style=flat-square&logo=openai&logoColor=white)](https://platform.openai.com/docs/api-reference)
[![Models on HF](https://img.shields.io/badge/🤗%20models-HuggingFace-yellow?style=flat-square)](#-datasets--models)

**[Quickstart](#-quickstart-60-seconds) · [How it works](#-how-it-works) · [Benchmarks](#-results-dataset-a-n5504) · [Claude Code](#-brick--claude-code) · [Models](#-datasets--models) · [FAQ](#-faq) · [Paper](#-paper) · [Contributing](#-contributing)**

</div>

---

## ⚡ Quickstart (60 seconds)

```bash
docker run --rm -p 18000:18000 \
  -e REGOLO_API_KEY=$REGOLO_API_KEY \
  ghcr.io/regolo-ai/brick:latest
```

Then call it like any OpenAI endpoint, just set `"model": "brick"`:

```bash
curl http://localhost:18000/v1/chat/completions \
  -H "Authorization: Bearer $REGOLO_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"brick","messages":[{"role":"user","content":"Prove that sqrt(2) is irrational"}]}'
```

The `x-selected-model` response header tells you which backend Brick picked.
That math prompt routes to a reasoning model; `"Hello"` routes to the cheapest one.

---

## 📊 Results (Dataset A, n=5,504)

Brick sits on the **Pareto frontier** of cost vs quality, dominating single-model
baselines and prior routers (RouteLLM, FrugalGPT, Cascade Routing) and approaching
the oracle ceiling.

<div align="center">
  <img src="docs/paper/figures/cost_pareto.png" alt="Cost vs accuracy on Dataset A: Brick traces the Pareto frontier" width="780">
</div>

| Setting | Accuracy | Cost (× cheapest) | Latency (avg) |
|---|---:|---:|---:|
| Always Qwen3.5-9b | 65.4% | 1.0× | 8.1 s |
| Always DeepSeek-v4-flash | 71.2% | 4.0× | 14.7 s |
| Always Kimi2.6 | 75.02% | 6.0× | 51.2 s |
| **Brick (max-quality)** | **76.98%** | **1.5×** | 22.8 s |
| **Brick (max-saving)** | 72.4% | **1.0×** | 9.4 s |
| _Oracle bound (3-model pool)_ | _83.25%_ | _n/a_ | _n/a_ |

**Brick beats always-Kimi at ~4× lower cost and roughly half the latency.**
Inter-rater agreement on the 3-judge eval panel: κ = 0.761. Full per-dimension
breakdown and baseline reproduction in [`packages/evals/baselines/RESULTS.md`](packages/evals/baselines/RESULTS.md).

---

## 🤔 Why Brick

| | Single model | RouteLLM | FrugalGPT / Cascade | **Brick** |
|---|:---:|:---:|:---:|:---:|
| One call per query (no cascade waste) | ✅ | ✅ | ❌ | ✅ |
| Capability-aware (6 dimensions) | n/a | ❌ binary | ❌ | ✅ |
| Complexity-aware | n/a | partial | ✅ | ✅ |
| Pool of N open + closed models | n/a | 2 | few | ✅ |
| Continuous cost ↔ quality knob | ❌ | ❌ | threshold | ✅ `r ∈ [-1, 1]` |
| Native multimodal (image / audio) | varies | ❌ | ❌ | ✅ |
| Drop-in OpenAI-compatible | n/a | n/a | n/a | ✅ |

Cascade routers (FrugalGPT, Cascade Routing) call models one after another until a
confidence check passes, paying for every miss in tokens and latency. Brick makes a
**single forward decision** per query, so there is nothing to waste.

---

## 🧠 How it works

For every request the router computes a **capability vector** and a **complexity
score**, then picks the model whose skill profile is closest to what the query needs.

```mermaid
flowchart LR
  Q([Query]) --> C[Capability classifier<br/>ModernBERT → p&#40;x&#41; ∈ Δ⁶]
  Q --> X[Complexity classifier<br/>Qwen3.5-0.8B + LoRA → τ]
  C --> R{{Skill-distance argmin<br/>Jₘ = Dₘ + β·aₘ}}
  X --> R
  R --> M1[qwen3.5-9b]
  R --> M2[deepseek-v4-flash]
  R --> M3[kimi2.6]
```

The query and each model live as vectors in the same capability space. The winner is
the model whose skill vector is nearest to the query's needs, biased by a cost term:

<div align="center">
  <img src="docs/paper/figures/mom_capability_3d.png" alt="Spatial routing: the query vector and per-model skill vectors in capability space" width="540">
</div>

1. **Capability** `p(x) ∈ Δ⁶`: soft assignment over `coding`, `creative_synthesis`, `instruction_following`, `math_reasoning`, `planning_agentic`, `world_knowledge` ([`brick-modernbert-capability-classifier`](https://huggingface.co/regolo/brick-modernbert-capability-classifier)).
2. **Complexity** `τ ∈ {easy, medium, hard}` ([`brick-complexity-2-eco`](https://huggingface.co/regolo/brick-complexity-2-eco), Qwen3.5-0.8B + LoRA).
3. **Objective** per model: `Jₘ = Dₘ + β·aₘ`, distance `Dₘ = ‖p(x) − sₘ‖` plus normalized cost `aₘ`.
4. **Argmin** over the pool → selected backend. The `r` knob slides the whole pool from max-saving to max-quality.

Multimodal inputs are preprocessed (OCR, Whisper-compatible STT) then routed as text, or
forwarded directly to a vision model. Details in [apps/router/README.md](apps/router/README.md) and the [paper](docs/paper/paper.pdf) §3.

---

## 🚀 Three ways to use Brick

### A. Run the gateway (Docker)

The [60-second quickstart](#-quickstart-60-seconds) above. See [docs/quickstart/quick.md](docs/quickstart/quick.md).

### B. CLI: self-host in one command

```bash
git clone https://github.com/regolo-ai/brick-SR1.git
cd brick-SR1/apps/cli && npm install && npm run build && npm link

brick init     # guided wizard → ~/.brick/profiles/<name>/
brick serve    # docker compose up
brick chat     # TUI chat against http://localhost:18000
brick route "what is 2+2?"   # show the routing decision for a prompt
```

Full walkthrough: [docs/quickstart/serve.md](docs/quickstart/serve.md) · CLI reference: [apps/cli/README.md](apps/cli/README.md).

### C. Reproduce the paper

<details>
<summary>Full evaluation pipeline (Dataset A, 5,504 queries)</summary>

```bash
git clone https://github.com/regolo-ai/brick-SR1 && cd brick-SR1

uv sync                                                  # Python workspaces
cd apps/cli && npm install && cd ../..                   # CLI

# Download HF artifacts (datasets + models)
python packages/datasets/scripts/download_dataset_a.py --out ./data/dataset_a
python packages/datasets/scripts/download_models.py     --out ./models

# Inference + grading
python packages/evals/scripts/100_run_inference.py  --config packages/evals/configs/protocols.yaml
python packages/evals/scripts/110_grade_inference.py
python packages/evals/scripts/130_aggregate_results.py | tee results.txt

# Expected: Brick max-quality ≈ 76.98% accuracy, oracle bound ≈ 83.25%
```

Full pipeline (judges, baselines, cost/Pareto analysis): [docs/quickstart/eval.md](docs/quickstart/eval.md).

</details>

---

## 🧠 Brick + Claude Code

Put one OpenAI/Anthropic-compatible endpoint in front of Claude Code, and Brick routes every request to **haiku**, **sonnet**, or **opus** based on capability and complexity. You keep the Claude Code UX; Brick picks the cheapest model that can do the job.

### Setup

```bash
brick claude on     # wires ANTHROPIC_BASE_URL in ~/.claude/settings.json, auto-starts the router
```

Then:
1. Open a **new** Claude Code session (your current session is unaffected).
2. In the `/model` picker, select **brick-claude** (it sits alongside the built-in opus/sonnet/haiku aliases, which it does not replace).

To revert:

```bash
brick claude off    # restores ANTHROPIC_BASE_URL, optionally stops the router
```

Use `brick claude on --no-start` to require an already-healthy router instead of auto-starting one, and `brick claude off --stop` / `--keep` to control the router without a prompt.

### The 5 modes

Each mode sets a routing preference `r` and a complexity (easy/medium/hard) to model map. Switch with `brick claude mode` or directly via `brick claude <mode>`.

| Mode | r | easy | medium | hard |
|------|-----|--------|--------|--------|
| eco  | -1   | haiku  | haiku  | haiku  |
| lite | -0.5 | haiku  | haiku  | sonnet |
| mid  | 0    | haiku  | sonnet | opus   |
| pro  | 0.5  | sonnet | sonnet | opus   |
| max  | 1    | opus   | opus   | opus   |

`mid` is the default. (On 1M-context requests the map shifts up since Haiku has no 1M variant: easy and medium resolve to sonnet, hard to opus.)

### How the effort picker works

The effort slider in Claude Code's `/model` picker selects the **Brick mode** (the model tier), not the thinking budget:

| Effort | Mode |
|--------|------|
| low    | eco  |
| medium | lite |
| high   | mid  |
| xhigh  | pro  |
| max    | max  |

Reasoning effort itself is then decided **autonomously per request** from the router's own signals (query difficulty plus the chosen model's headroom). You pick the tier; Brick picks how hard to think.

### Native models bypass the router

Selecting **opus**, **sonnet**, or **haiku** explicitly in the picker skips Brick entirely: the request is forwarded verbatim to that exact model, with no skill routing and no effort override. Only **brick-claude** runs the router.

### Observability

```bash
brick claude status         # live dashboard (default in an interactive terminal)
brick claude status --once  # static one-shot view
```

The dashboard reports, since the last router restart:
- **Routed by model**: count and percent per model.
- **Per-model effort distribution**: how reasoning effort spread out within each model.
- **Difficulty mix**: the classifier's easy/medium/hard verdicts across routed requests.
- **Economy**: an estimated `saved ~X% vs all-opus` over the routed request count (a relative estimate from request mix, excluding real token counts and caching).

It also shows connection/wiring state, classifier latency (avg, p50, p95), and fallback rate.

<div align="center">
  <img width="286" height="440" alt="image" src="https://github.com/user-attachments/assets/d7741efa-0d63-45f3-83f3-39d16bca5dab" />
</div>
  
### Works with workflows and subagents

Brick routing is per request. In Claude Code workflows and subagents, each agent's call is routed **independently** as long as that agent uses **brick-claude**, so a cheap subagent task can land on haiku while a hard one escalates to opus in the same run.

---

## 🤗 Datasets & models

| Artifact | HF Repo | Type | Notes |
|---|---|---|---|
| Dataset A (eval) | [`regolo/brick-dataset-A-routing-eval`](https://huggingface.co/datasets/regolo/brick-dataset-A-routing-eval) | dataset | 5,504 queries, 6 dims, per-model verdicts |
| Dataset B (training) | [`massaindustries/dataset-B-modernbert-train`](https://huggingface.co/datasets/massaindustries/dataset-B-modernbert-train) | dataset | ~50k labeled, multi-label |
| Capability classifier | [`regolo/brick-modernbert-capability-classifier`](https://huggingface.co/regolo/brick-modernbert-capability-classifier) | model | ModernBERT-base, 6-label sigmoid |
| Complexity classifier | [`regolo/brick-complexity-2-eco`](https://huggingface.co/regolo/brick-complexity-2-eco) | model | Qwen3.5-0.8B + LoRA, 3-class |

Download recipes: [`packages/datasets/`](packages/datasets/).

---

## 🗂️ What's in the repo

A monorepo to **run**, **use**, and **reproduce** every result in the Brick paper.

| Component | Path | Purpose |
|---|---|---|
| **Router** (Go + Rust) | [`apps/router/`](apps/router/) | OpenAI-format gateway: capability + complexity classifiers, dispatch to the best backend |
| **CLI** (`brick`) | [`apps/cli/`](apps/cli/) | TypeScript/oclif companion to self-host in one command |
| **Training** | [`packages/training/`](packages/training/) | ModernBERT capability sweep + complexity LoRA recipes |
| **Evaluation** | [`packages/evals/`](packages/evals/) | Dataset A pipeline + 3-judge majority-vote panel |
| **Baselines** | [`packages/evals/baselines/`](packages/evals/baselines/) | Zero-shot RouteLLM, FrugalGPT, Cascade comparisons |
| **Paper** | [`docs/paper/`](docs/paper/) | LaTeX source, figures, compiled PDF |

<details>
<summary>Full directory tree</summary>

```
brick-SR1/
├── apps/
│   ├── router/                 # Go + Rust gateway (was vLLM Spatial Router fork)
│   │   ├── src/spatial-router/ #   Go (HTTP proxy, routing pipeline)
│   │   ├── candle-binding/     #   Rust (ML embeddings via candle)
│   │   ├── ml-binding/         #   Rust (Linfa classical ML)
│   │   ├── nlp-binding/        #   Rust (BM25 + n-gram)
│   │   └── Dockerfile
│   └── cli/                    # @regolo-ai/brick CLI (TypeScript + oclif + ink)
├── packages/
│   ├── training/               # Dataset B pipeline + ModernBERT/complexity training
│   ├── evals/                  # Dataset A graders + 00..140 pipeline + baselines/
│   └── datasets/               # HF download recipes (no data in git)
├── docs/
│   ├── paper/                  # paper.tex + figures + compiled PDF
│   └── quickstart/             # quick.md, serve.md, eval.md
├── deploy/                     # docker-compose, addons, Windows installer
├── config.yaml                 # router runtime config
├── package.json / pyproject.toml  # npm + uv workspace roots
└── Makefile                    # build / test / lint / docker-build / release
```

</details>

---

## 🛠️ Develop

```bash
make install   # npm install (apps/cli) + uv sync (packages/*)
make build     # CLI + router Docker image
make test      # Go tests + Python pytest + CLI vitest
make lint      # pre-commit run --all-files
```

Per-component docs: [router](apps/router/README.md) · [CLI](apps/cli/README.md) · [training](packages/training/README.md) · [evals](packages/evals/README.md) · [datasets](packages/datasets/README.md) · [baselines](packages/evals/baselines/README.md).

<details>
<summary>Distribution channels (work in progress)</summary>

| Channel | Status |
|---|---|
| Source clone + `npm link` | available |
| Docker GHCR (`ghcr.io/regolo-ai/brick`) | pending first push (tag `v2.1.0`) |
| npm (`@regolo-ai/brick`) | pending `NPM_TOKEN` secret |
| Docker Hub mirror (`docker.io/regolo/brick`) | pending Docker Hub secrets |

</details>

---

## ❓ FAQ

<details>
<summary><b>How is Brick different from a cascade router like FrugalGPT?</b></summary>

A cascade calls models in sequence (cheap first, escalate on low confidence) and pays for every miss in tokens and latency. Brick makes a single forward decision per query from a capability vector and a complexity score, so there is no wasted call. See [Why Brick](#-why-brick).
</details>

<details>
<summary><b>Which backend did Brick pick for my request?</b></summary>

Read the `x-selected-model` response header. Every `/v1/chat/completions` and `/v1/messages` response carries it.
</details>

<details>
<summary><b>How do I trade cost against quality?</b></summary>

Slide the `r` knob in `r ∈ [-1, 1]`. At `r = -1` Brick favors the cheapest capable model (max-saving), at `r = 1` it favors the strongest (max-quality). For Claude Code the same idea is exposed as 5 named modes, see [the 5 modes](#the-5-modes).
</details>

<details>
<summary><b>Do I need GPUs to run the gateway?</b></summary>

No. The router and both classifiers run on CPU. GPUs only matter if you self-host the backend LLMs; with a hosted pool (Regolo, Anthropic, etc.) a CPU box is enough.
</details>

<details>
<summary><b>Can I use my own model pool?</b></summary>

Yes. The pool, per-model skill vectors, costs, and the `model_map` live in `config.yaml` (`skill_router.models`). Add or swap any OpenAI-compatible backend. See [apps/router/README.md](apps/router/README.md).
</details>

<details>
<summary><b>What is the upstream for the OpenAI-compatible endpoint failing with 401/insufficient_quota?</b></summary>

That error comes from the backend provider, not Brick. Check the credential you forward (`REGOLO_API_KEY` or your own key); Brick passes Authorization through unchanged.
</details>

---

## 🤝 Contributing

Contributions are welcome. The short loop:

```bash
make install   # deps for CLI + Python workspaces
make test      # Go + pytest + vitest, run before opening a PR
make lint      # pre-commit run --all-files
```

1. Open an [issue](https://github.com/regolo-ai/brick-SR1/issues) to discuss non-trivial changes first.
2. Branch from `main`, keep commits focused, follow the existing style of the files you touch.
3. Make sure `make test` and `make lint` pass.
4. Open a PR with a clear description of the what and the why.

For architecture and per-component conventions, start from [What's in the repo](#-whats-in-the-repo) and the component READMEs linked under [Develop](#-develop).

---

## 📄 Paper

> **Brick and the Mixture-of-Models (MoM) Paradigm: Bridging Open- and Closed-Weight LLM Pools**
> Francesco Massa, Marco Cristofanilli (2026) · Built at [Regolo.ai](https://regolo.ai) (Seeweb)

Pre-built PDF: [`docs/paper/paper.pdf`](docs/paper/paper.pdf) · compile with `cd docs/paper && latexmk -pdf paper.tex`.

```bibtex
@misc{massa2026brick,
  title  = {Brick and the Mixture-of-Models ({MoM}) Paradigm:
            Bridging Open- and Closed-Weight {LLM} Pools},
  author = {Massa, Francesco and Cristofanilli, Marco},
  year   = {2026},
  url    = {https://github.com/regolo-ai/brick-SR1}
}
```

---

## 📈 Star history

<a href="https://star-history.com/#regolo-ai/brick-SR1&Date">
  <img src="https://api.star-history.com/svg?repos=regolo-ai/brick-SR1&type=Date" alt="Star history chart" width="600">
</a>

---

