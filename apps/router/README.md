# `apps/router/`: Brick Routing Gateway (Go + Rust)

The HTTP proxy that exposes a single virtual model `model: "brick"` over an OpenAI-compatible API and dispatches each request to the best backend in a multi-model pool.

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│  HTTP request (OpenAI chat/completions, model: "brick")              │
│         ↓                                                             │
│  Modality detection (text / image / audio / mixed)                    │
│         ↓                              ┌─ image+text   → vision model │
│  Preprocessing (OCR, STT in parallel)  ├─ image only   → OCR + …      │
│         ↓                              ├─ audio        → STT + …      │
│  Spatial routing pipeline (text)      └─ text         → pipeline     │
│         ↓                                                             │
│  ① Capability vector p(x) ∈ Δ⁶  via ModernBERT classifier (CGO)       │
│  ② Complexity τ ∈ {easy,medium,hard} via Qwen+LoRA classifier (HTTP)  │
│  ③ Per-model score J_m = ||p(x) − s_m|| + β · a_m                     │
│  ④ argmin_m J_m → selected backend                                    │
│         ↓                                                             │
│  Forward to backend (Regolo, OpenRouter, OpenAI-compatible provider)  │
│         ↓                                                             │
│  Response (with `x-selected-model` header attached)                   │
└─────────────────────────────────────────────────────────────────────┘
```

## Layout

```
apps/router/
├── src/spatial-router/         # Go module github.com/regolo-ai/brick-SR1/apps/router/src/spatial-router
│   ├── cmd/main.go              # HTTP server entrypoint
│   └── pkg/
│       ├── proxy/               # HTTP server, /v1/chat/completions, /v1/models, /v1/messages (Anthropic)
│       ├── brickrouting/        # routing math (capability + complexity → backend)
│       ├── config/              # YAML schema, BrickExtension, VirtualModelConfig
│       ├── modeldownload/       # HF snapshot download on startup
│       ├── complexityserver/    # spawn local complexity classifier subprocess (optional)
│       └── observability/, cache/, plugins/, …
├── candle-binding/              # Rust: ML embeddings via candle (compiled to .so, linked via CGO)
├── ml-binding/                  # Rust: Linfa classical ML (.so via CGO)
├── nlp-binding/                 # Rust: BM25 + n-gram NLP utilities (.so via CGO)
├── config/                      # default config.yaml baked into the image
├── scripts/, benchmark/         # smoke + perf scripts
└── Dockerfile                   # multi-stage: 3× Rust builders → Go builder → debian:slim runtime
```

## Build

```bash
# From repo root (build context = repo root)
docker build -f apps/router/Dockerfile -t brick:dev .
```

For local Go development:

```bash
cd apps/router
make -f ../../Makefile test-router         # or:
cd src/spatial-router && go test ./...
```

Rust libraries:

```bash
cd apps/router/candle-binding && cargo build --release --no-default-features
cd apps/router/ml-binding     && cargo build --release
cd apps/router/nlp-binding    && cargo build --release
```

## Run

```bash
# Via Docker (default config)
docker run --rm -p 18000:18000 -e REGOLO_API_KEY=$REGOLO_API_KEY \
  ghcr.io/regolo-ai/brick:latest

# Via Docker with custom config
docker run --rm -p 18000:18000 \
  -v $(pwd)/config.yaml:/app/config/config.yaml:ro \
  -e REGOLO_API_KEY=$REGOLO_API_KEY \
  ghcr.io/regolo-ai/brick:latest

# Or via the CLI (preferred for self-hosting)
brick init && brick serve
```

## Configuration

The default config baked into the image is `apps/router/config/config.yaml`. A canonical user-editable copy lives at the repo root (`config.yaml`). Key sections:

- `providers:`: backend LLM endpoints (OpenAI-compatible + auth)
- `models:`: pool members with per-model skill vector `s_m` and cost `a_m`
- `capability_model:`: path or HF id of the capability classifier
- `complexity_model:`: path or HF id of the complexity classifier
- `routing:`: math knobs (`tau`, `prior_strength`, `cost_penalty_beta`, etc.)
- `brick:` (the multimodal extension): STT/OCR/Vision endpoints and OCR fallback threshold
- `anthropic_passthrough:`: Anthropic-compatible `/v1/messages` proxy for Claude Code clients

See [`config.yaml`](../../config.yaml) at repo root for a complete commented template.

## Endpoints

| Path | Purpose |
|------|---------|
| `GET  /health` | liveness probe |
| `GET  /v1/models` | OpenAI-format model list (includes `brick` virtual model + backend pool) |
| `POST /v1/chat/completions` | OpenAI chat completion (`model: "brick"` triggers routing) |
| `POST /v1/messages` | Anthropic-compatible passthrough (when `anthropic_passthrough.enabled: true`) |
| `GET  /api/v1/diag/classifier` | self-diagnostic for capability/complexity classifiers |
| `GET  /metrics` | Prometheus metrics (separate port, default 9190) |

## Headers

Request:
- `Authorization: Bearer <key>`: provider key.
- `x-selected-model: <model-id>`: bypass routing, pin to a specific backend.
- `X-Brick-Thinking: off|low|med|high|auto`: request reasoning effort hint.

Response:
- `x-selected-model: <backend-id>`: which model actually answered.

## Complexity classifier (GPU addon)

For best-quality complexity scoring, run the `brick-complexity-server` as a GPU sidecar. See [`deploy/addons/brick-complexity-server/`](../../deploy/addons/brick-complexity-server/) and `complexityserver/spawn.go` for the spawn-on-startup workflow.

## Tests

```bash
cd apps/router/src/spatial-router
go vet ./...
go test ./...

# Rust
cd apps/router/candle-binding && cargo test --no-default-features
```

## Where this code came from

This router descends from [`vllm-project/spatial-router`](https://github.com/vllm-project/spatial-router) (Apache-2.0) with substantial extensions for the Brick paper:
- 6-dim capability classifier (ModernBERT instead of MMBERT)
- Complexity score integration
- Skill–distance objective `J_m = D_m + β · a_m`
- Multimodal preprocessing (OCR + Whisper-compatible STT) under the unified `model: "brick"` virtual model
- Anthropic passthrough for Claude Code

Upstream attribution is in [`NOTICE`](../../NOTICE).
