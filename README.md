<div align="center">

# Brick: Multimodal LLM Routing Gateway

**A spatial-routing gateway that exposes a single virtual model (`model: "brick"`) over OpenAI-compatible APIs, with per-query capability + complexity classifiers selecting the best backend from a pool of open- and closed-weight LLMs.**

[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)
[![Go](https://img.shields.io/badge/Go-1.24-00ADD8.svg)](https://go.dev)
[![Rust](https://img.shields.io/badge/Rust-1.90-orange.svg)](https://www.rust-lang.org)
[![Python](https://img.shields.io/badge/Python-3.10+-3776AB.svg)](https://www.python.org)
[![OpenAI Compatible](https://img.shields.io/badge/API-OpenAI%20Compatible-green.svg)](https://platform.openai.com/docs/api-reference)

*Reference implementation for the paper [Brick and the Mixture-of-Models (MoM) Paradigm: Bridging Open- and Closed-Weight LLM Pools](docs/paper/paper.pdf).*
*Author: Francesco Massa ([f.massa@regolo.ai](mailto:f.massa@regolo.ai)) · Built at [Regolo.ai](https://regolo.ai) (Seeweb).*

</div>

---

## What this repo contains

A complete monorepo to **run**, **use**, and **reproduce** every result in the Brick paper:

| Component | Path | Purpose |
|---|---|---|
| **Router (Go + Rust)** | `apps/router/` | HTTP gateway that accepts OpenAI-format requests, runs capability + complexity classifiers, dispatches to the best backend in the model pool. Multi-stage Docker image. |
| **CLI (`brick`)** | `apps/cli/` | TypeScript/oclif companion to self-host the gateway with one command. Published as `@regolo-ai/brick` on npm. |
| **Training scripts** | `packages/training/` | ModernBERT capability classifier sweep + complexity LoRA training. Recipes for the published HF models. |
| **Evaluation pipeline** | `packages/evals/` | Dataset A grading pipeline (00..140 scripts), 3-judge panel (gpt-5.4-mini + Mistral + GLM majority-vote), per-dimension graders. |
| **Baselines** | `packages/evals/baselines/` | Zero-shot RouteLLM, FrugalGPT, cascade-routing comparisons reported in the paper. |
| **Dataset / model recipes** | `packages/datasets/` | HuggingFace download scripts for Dataset A, Dataset B, capability + complexity classifiers. |
| **Paper** | `docs/paper/` | LaTeX source (`paper.tex`, `dataset_a.tex`, `algorythm.tex`, `routers.tex`) + figures + compiled `paper.pdf`. |
| **Deploy manifests** | `deploy/` | docker-compose stacks (single, with brick-cc addon, with classifier tunnel), Windows installer. |

---

## Quickstart: three entry points

Pick one depending on what you want to do.

### A. Run the gateway (Docker, 1 minute)

```bash
docker run --rm -p 18000:18000 \
  -e REGOLO_API_KEY=$REGOLO_API_KEY \
  ghcr.io/regolo-ai/brick:latest

# health
curl http://localhost:18000/health

# OpenAI-compatible chat completion
curl http://localhost:18000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $REGOLO_API_KEY" \
  -d '{"model":"brick","messages":[{"role":"user","content":"Hello"}]}'
```

The `x-selected-model` response header reports which backend was chosen. See [docs/quickstart/quick.md](docs/quickstart/quick.md).

### B. Install and use the CLI (`brick`)

> The npm package `@regolo-ai/brick` is not yet published (see [Distribution roadmap](#distribution-roadmap) below). Install from source:

```bash
git clone https://github.com/regolo-ai/brick-SR1.git
cd brick-SR1/apps/cli
npm install
npm run build
npm link                       # makes `brick` available on $PATH

brick init                     # guided wizard, creates ~/.brick/profiles/<name>/
brick serve                    # docker compose up
brick chat                     # TUI chat against http://localhost:18000
brick route "what is 2+2?"     # one-shot routing decision
brick status                   # active profile + container state
```

See [docs/quickstart/serve.md](docs/quickstart/serve.md) for the full CLI walkthrough.

### C. Reproduce the paper evaluation

```bash
git clone https://github.com/regolo-ai/brick-SR1 && cd brick-SR1

# Install workspaces
uv sync                                                  # Python (training/evals/datasets)
cd apps/cli && npm install && cd ../..                   # CLI

# Download HF artifacts (datasets + models)
python packages/datasets/scripts/download_dataset_a.py --out ./data/dataset_a
python packages/datasets/scripts/download_models.py     --out ./models

# Run inference + grading on Dataset A (5,504 queries)
python packages/evals/scripts/100_run_inference.py     --config packages/evals/configs/protocols.yaml
python packages/evals/scripts/110_grade_inference.py
python packages/evals/scripts/130_aggregate_results.py | tee results.txt

# Expected: Brick max-quality ≈ 76.98% accuracy, oracle bound ≈ 83.25%
```

See [docs/quickstart/eval.md](docs/quickstart/eval.md) for the full pipeline (with judges, baselines, cost/Pareto analysis).

---

## Repository layout

```
brick-SR1/
├── apps/
│   ├── router/                 # Go + Rust gateway (was vLLM Spatial Router fork)
│   │   ├── src/spatial-router/  # Go (HTTP proxy, routing pipeline)
│   │   ├── candle-binding/       # Rust (ML embeddings via candle)
│   │   ├── ml-binding/           # Rust (Linfa classical ML)
│   │   ├── nlp-binding/          # Rust (BM25 + n-gram)
│   │   ├── config/, scripts/, benchmark/
│   │   └── Dockerfile
│   └── cli/                    # @regolo-ai/brick CLI (TypeScript + oclif + ink)
├── packages/
│   ├── training/               # Dataset B pipeline + ModernBERT/complexity training
│   │   ├── dataset_b/          #   data generation (01..07) + judges + push HF
│   │   └── modernbert/         #   training scripts + W&B sweep configs
│   ├── evals/                  # Dataset A graders + 00..140 pipeline
│   │   ├── scripts/            #   normalize → tokenize → infer → grade → aggregate
│   │   ├── src/brick_evals/    #   Python package (clients, graders, judge, schema)
│   │   ├── configs/            #   judges.yaml, models.yaml, protocols.yaml, …
│   │   ├── tests/              #   pytest suite (smoke + unit)
│   │   └── baselines/          #   RouteLLM, FrugalGPT, cascade-routing
│   └── datasets/               # HF download recipes (no data in git)
├── docs/
│   ├── paper/                  # paper.tex + figures + compiled PDF
│   └── quickstart/             # quick.md, serve.md, eval.md
├── deploy/                     # docker-compose, addons, Windows installer
├── config.yaml                 # router runtime config (docker-compose volume mount)
├── package.json                # npm workspace root
├── pyproject.toml              # uv workspace root
└── Makefile                    # build / test / lint / docker-build / release
```

---

## How Brick decides which backend handles a query

For every text request, the router computes:

1. **Capability vector** `p(x) ∈ Δ⁶`: soft assignment over 6 dimensions (`coding`, `creative_synthesis`, `instruction_following`, `math_reasoning`, `planning_agentic`, `world_knowledge`), produced by [`regolo/brick-modernbert-capability-classifier`](https://huggingface.co/regolo/brick-modernbert-capability-classifier).
2. **Complexity score** `τ ∈ {easy, medium, hard}` from [`regolo/brick-complexity-2-eco`](https://huggingface.co/regolo/brick-complexity-2-eco) (Qwen3.5-0.8B + LoRA).
3. **Skill–distance objective** per model `m`: `J_m = D_m + β · a_m`, with `D_m = || p(x) - s_m ||` over a per-model skill vector and `a_m` the normalized cost.
4. **Argmin** over the pool → selected backend (`qwen3.5-9b`, `deepseek-v4-flash`, `kimi2.6`, …).

Multimodal inputs (image, audio) are preprocessed (OCR / Whisper-compatible STT) and then either routed through the same pipeline (text-derived content) or forwarded directly to a vision model. See [apps/router/README.md](apps/router/README.md) and [`docs/paper/paper.tex`](docs/paper/paper.tex) §3.

---

## Headline result (Dataset A, n = 5,504)

| Setting | Accuracy | Cost (× cheapest) | Latency (avg, s) |
|---|---:|---:|---:|
| Always Qwen3.5-9b | 65.4% | 1.0× | 8.1 |
| Always DeepSeek-v4-flash | 71.2% | 4.0× | 14.7 |
| Always Kimi2.6 | 75.02% | 6.0× | 51.2 |
| **Brick (max-quality)** | **76.98%** | **1.5×** | **22.8** |
| **Brick (max-saving)** | 72.4% | **1.0×** | 9.4 |
| Oracle bound (3-model pool) | 83.25% | n/a | n/a |

Brick beats always-Kimi at ~4× lower cost and roughly half the latency. Inter-rater κ on the 3-judge eval panel: 0.761. Full per-dimension breakdown and baseline comparisons (RouteLLM, FrugalGPT, cascade) in [`docs/paper/paper.tex`](docs/paper/paper.tex) and [`packages/evals/baselines/RESULTS.md`](packages/evals/baselines/RESULTS.md).

---

## Datasets and models on HuggingFace

| Artifact | HF Repo | Type | Notes |
|---|---|---|---|
| Dataset A (eval) | [`regolo/brick-dataset-A-routing-eval`](https://huggingface.co/datasets/regolo/brick-dataset-A-routing-eval) | dataset | 5,504 queries, 6 dims, per-model verdicts |
| Dataset B (training) | [`massaindustries/dataset-B-modernbert-train`](https://huggingface.co/datasets/massaindustries/dataset-B-modernbert-train) | dataset | ~50k labeled, multi-label per query |
| Capability classifier | [`regolo/brick-modernbert-capability-classifier`](https://huggingface.co/regolo/brick-modernbert-capability-classifier) | model | ModernBERT-base, 6-label sigmoid |
| Complexity classifier | [`regolo/brick-complexity-2-eco`](https://huggingface.co/regolo/brick-complexity-2-eco) | model | Qwen3.5-0.8B + LoRA, 3-class |

Download recipes: [`packages/datasets/`](packages/datasets/).

---

## Develop, build, test

```bash
make install        # npm install (apps/cli) + uv sync (packages/*)
make build          # CLI + router Docker image
make test           # Go tests + Python pytest + CLI vitest
make lint           # pre-commit run --all-files
make docker-build   # → ghcr.io/regolo-ai/brick:dev
```

Per-component docs:
- [apps/router/README.md](apps/router/README.md): router architecture, build, config, GPU complexity addon
- [apps/cli/README.md](apps/cli/README.md): `brick` CLI commands, profiles, custom Docker images
- [packages/training/README.md](packages/training/README.md): ModernBERT capability + complexity LoRA training tutorial (W&B sweep audit)
- [packages/evals/README.md](packages/evals/README.md): Dataset A pipeline (00..140) + 3-judge panel
- [packages/datasets/README.md](packages/datasets/README.md): HF download recipes
- [packages/evals/baselines/README.md](packages/evals/baselines/README.md): RouteLLM / FrugalGPT / Cascade reproduction

---

## Paper

> **Brick and the Mixture-of-Models (MoM) Paradigm: Bridging Open- and Closed-Weight LLM Pools**
> Francesco Massa, Marco Cristofanilli (2026)

Compile from source: `cd docs/paper && latexmk -pdf paper.tex`. Pre-built PDF: [`docs/paper/paper.pdf`](docs/paper/paper.pdf).

### Citation

```bibtex
@misc{massa2026brick,
  title  = {Brick and the Mixture-of-Models ({MoM}) Paradigm:
            Bridging Open- and Closed-Weight {LLM} Pools},
  author = {Massa, Francesco and Cristofanilli, Marco},
  year   = {2026},
  url    = {https://github.com/regolo-ai/brick-SR1},
  note   = {Companion code and datasets at regolo-ai/brick-SR1}
}
```

---

## Distribution roadmap

Distribution channels currently in setup. Until each is ready, use the source-install commands above.

| Channel | Status | Action needed |
|---|---|---|
| Source clone + `npm link` | available | `git clone` + `cd apps/cli && npm install && npm run build && npm link` |
| Docker GHCR (`ghcr.io/regolo-ai/brick`) | pending first push | tag `v2.0.0` triggers `.github/workflows/docker.yml` |
| npm registry (`@regolo-ai/brick`) | pending `NPM_TOKEN` secret | set repo secret, then tag `v2.0.0` triggers `.github/workflows/npm-publish.yml` |
| Docker Hub mirror (`docker.io/regolo/brick`) | pending `DOCKERHUB_USERNAME` + `DOCKERHUB_TOKEN` secrets | set repo secrets; the same workflow auto-pushes when both are present |

Repo secrets are configured at https://github.com/regolo-ai/brick-SR1/settings/secrets/actions.

---

## License

Brick is released under the [Apache License 2.0](LICENSE). The router descends from [vLLM Spatial Router](https://github.com/vllm-project/spatial-router); upstream attributions in [`NOTICE`](NOTICE).
