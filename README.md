# Brick

Brick routes a query to a model using a local six-dimensional SystemOne capability
vector. It provides OpenAI Chat Completions, Anthropic Messages, and native
Responses gateways, with streaming, authentication, tools, and multimodal transport.

The routing flow is:

`query → SystemOne sigmoid vector → linear knob → Euclidean distance → model`

SystemOne inference uses **PyTorch and Hugging Face Transformers**, following the
model's reference implementation. It runs in FP32 on CPU or BF16 on CUDA, uses
FlashAttention 2 when available on CUDA, and otherwise uses SDPA. A persistent
local Python worker keeps the model loaded. The Go gateway embeds the worker
source and communicates with it over pipes.

## Routing

The pinned checkpoint is `massaindustries/brick-systemone-large-v2`, revision
`f6375c086ab5901631f80f3be442a41fb70b3386`. Its output order is:

1. `instruction_following`
2. `coding`
3. `math_reasoning`
4. `world_knowledge`
5. `planning_agentic`
6. `creative_synthesis`

Each output is an independent sigmoid value in `[0, 1]`. The vector is neither
rounded nor normalized to sum to one. The tokenizer respects the checkpoint's
8192-token context limit.

The profile knob defaults to `0` and accepts values from `-1` to `+1`:

```text
scaled_query[i] = clamp(query[i] × (1 + 0.5 × knob), 0, 1)
distance(model) = sqrt(sum((scaled_query[i] - model.skill_vector[i])²))
```

The closest eligible model wins. Exact ties preserve the configured model order.
Model vectors are unchanged by the knob. If a profile declares a different
capability order, the router explicitly reorders its vectors into checkpoint
order. Active-pool and modality filters restrict the eligible models.
Invalid vectors, an empty candidate intersection, and inference failures return
explicit errors.

Request effort overrides the profile knob across all three protocols:

| Request effort | Knob |
|---|---:|
| `low` | -1 |
| `medium` | -0.5 |
| `high` | 0 |
| `xhigh` | +0.5 |
| `max` | +1 |

An absent effort uses the profile knob. Provider-supported reasoning controls are
forwarded, with only required provider adaptations. Brick does not infer reasoning
effort. Explicit model selections and configured fixed models bypass inference.

## Install and run locally

Prepare a Python environment using
[the runtime requirements](apps/router/systemone/requirements.txt), and set
`BRICK_SYSTEMONE_PYTHON` to its interpreter:

```bash
python3 -m venv /path/to/systemone-env
/path/to/systemone-env/bin/python -m pip install -r apps/router/systemone/requirements.txt
export BRICK_SYSTEMONE_PYTHON=/path/to/systemone-env/bin/python
```

Without that variable, the runtime uses `python3` on PATH. The installer downloads
private checkpoint assets using `HF_TOKEN`, verifies SHA-256 checksums, and checks
real inference. For an offline installation, set `BRICK_MODEL_ASSETS` to a directory
containing the pinned assets. The runtime also verifies local assets against the
pinned manifest. Hub credentials are not written into completion markers or runtime
environment snapshots. Weights stay outside the source repository.

```bash
brick profile create work
brick profile edit work
brick start work
brick status work
brick logs work
brick stop work
```

The profile editor configures providers, the model pool, capability vectors,
provider-supported thinking modes, and the routing knob. Claude and Codex profiles
connect their official harnesses through the existing native transports.

`brick route "Write a parser" --json` runs local routing only. It returns the
original vector, scaled vector, knob, candidate distances, selected model, and
latency. Add `--effort xhigh` to inspect a request override. `brick generate` and
`brick chat` perform generation through the chosen provider.

See [local lifecycle and installation](docs/quickstart/serve.md) for package
installation, restart, update, rollback, and profile storage details.

## Configuration and migration

Profiles use `config_version: 2`. The routing block contains:

```yaml
config_version: 2
skill_router:
  enabled: true
  knob: 0
  systemone:
    local_path: /external/path/to/verified/systemone-assets
  capabilities: [instruction_following, coding, math_reasoning, world_knowledge, planning_agentic, creative_synthesis]
  models:
    - model: small
      skill_vector: [0.5, 0.4, 0.4, 0.6, 0.3, 0.5]
    - model: large
      skill_vector: [0.9, 0.9, 0.9, 0.9, 0.9, 0.9]
  active_models: [small, large]
```

Provider endpoints, credentials, and `model_config` entries complete the profile;
see [the examples](examples) and [default templates](apps/cli/templates).
The CLI supplies the installed checkpoint directory via `--model-dir`.

Legacy profiles migrate with exact configuration and environment backups, followed
by atomic replacement. Migration preserves providers, generation credentials,
model priority, active-model order, capability order, and vector values. The old
numeric routing preference becomes `skill_router.knob`; obsolete fields are
removed. Incompatible vectors stop migration before any files are written.
Repeating migration performs no second write.

## Observability and protocol behavior

- `/v1/routing/test`: local routing diagnostics, without generation.
- `/api/v1/diag/systemone`: local engine, checkpoint identity, device, and readiness.
- `/api/v1/stats`: durable calls, models, token usage, and
  routing/provider/overall latencies.
- `/api/v1/economics`: token-based cost accounting using configured pricing.
- `/health`: runtime identity and routing readiness.
- `/metrics`: request counters and local SystemOne inference latency.

Provider-native Responses compaction is transported unchanged. The gateway does
not perform local conversation compaction or keep conversation routing state.
Native Anthropic requests retain tools, streaming, cache controls, and supported
context-management operations. Model capability declarations determine whether
Responses requests can use a selected backend.

## Development and historical research

```bash
make install
export BRICK_SYSTEMONE_PYTHON="$(pwd)/.venv/bin/python"
make test
make lint
python3 scripts/build_runtime.py
```

The build produces a Go runtime bundle and its Python requirements. It does not
bundle weights or a Candle library. Real CPU stack verification can be run using:

```bash
.venv/bin/python scripts/test_systemone_stack.py /external/path/to/systemone-assets
.venv/bin/python scripts/test_native_labels.py /path/to/brick-runtime /external/path/to/systemone-assets
```

These checks use the local checkpoint and make no generation-provider calls.
Historical [training](packages/training/README.md),
[evaluation](packages/evals/README.md), and [paper](docs/paper/README.md) workflows
remain available. Their older calibrated-router results describe the historical
implementation, not the current SystemOne router.

Contribution and publication rules are defined in [AGENTS.md](AGENTS.md).
This repository is licensed under [Apache-2.0](LICENSE); see [NOTICE](NOTICE) and
[third-party notices](THIRD_PARTY_NOTICES.md).
