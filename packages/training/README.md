# Capability training and Dataset B generation

This workspace retains the GPU training pipeline for the six-label ModernBERT
capability classifier, its evaluation and export tools, and Dataset B
generation.
Complexity classification in the npm runtime uses a configured API. No local
complexity training script is distributed here.

The npm installer downloads the pinned capability checkpoint. Training a new
checkpoint is a separate experiment: it must not silently replace release
assets. Python training uses independent sigmoid scores; the historical Candle
runtime uses softmax normalization and 512-token truncation. This refactor
preserves the runtime algorithm and checks it against the pre-extraction corpus.

## Dependencies and entrypoints

From the repository root:

```bash
uv sync --frozen --all-packages
uv run --frozen --package brick-training python packages/training/modernbert/scripts/train_modernbert.py --help
uv run --frozen --package brick-training python packages/training/modernbert/scripts/select_top3.py --help
```

`modernbert/scripts/dataset_loader.py` and `metrics.py` supply training and
human-evaluation inputs and metrics. `sanity_check.py` and `train_modernbert.py
--smoke --no_wandb` exercise a small training run but still require downloaded
models and datasets. `eval_human.py`, `manual_annotate_200.py` and
`bench_latency.py` support checkpoint evaluation. `export_for_candle.py` exports
the selected weights for the native runtime.

## Sweeps and publication

Review `modernbert/configs/sweep.yaml`, then run from
`packages/training/modernbert`:

```bash
uv run --frozen --package brick-training wandb sweep configs/sweep.yaml
uv run --frozen --package brick-training wandb agent ENTITY/PROJECT/SWEEP_ID
uv run --frozen --package brick-training python scripts/select_top3.py --project ENTITY/PROJECT --sweep SWEEP_ID
```

These operations contact Weights & Biases and train on the configured dataset.
`push_winner.py` is an explicit Hub publication entrypoint; inspect its source
and selected checkpoint before using it. SkyPilot recipes provision external
capacity from the repository root. The
operator supplies uv, credentials, and an image with locked SGLang/vLLM GPU
dependencies for serving; these recipes never install unpinned server packages.
Existing shared GPU pools should use their scheduler instead.

They are separate from Linux npm acceptance and are not launched by CI.

## Dataset B

From `packages/training/dataset_b`, use a configured OpenAI-compatible
generation
or judge endpoint:

```bash
uv run --frozen --package brick-training python scripts/01_generate_queries.py --endpoint http://localhost:30000/v1/chat/completions --max 10
uv run --frozen --package brick-training python scripts/02_run_judge.py --name mistral --endpoint http://localhost:30000/v1/chat/completions
uv run --frozen --package brick-training python scripts/03_aggregate.py
```

Generation settings and prompts are in `configs/` and `prompts/`. Run the judge
stage for each configured judge before aggregation. Stages 04, 06 and 07 prepare
human annotation and agreement measurements. Stage 05 publishes the generated
dataset. `scripts/serve_model.sh`, `scripts/run_client.sh` and `sky/` support
external GPU
runs;
they are not installed with Brick.

## Notifications and verification

Notifications are disabled unless `BRICK_NOTIFY_FROM`, `BRICK_NOTIFY_TO` and
`BRICK_SMTP_PASSWORD_FILE` are configured. No credentials or recipients are
embedded in published scripts. `sweep_email_monitor.py` uses the same notifier.

Offline CI checks Python syntax, lint and evaluation units. Full training,
human annotation, remote judging and Hub publication require their external
inputs and are not claimed by the native-runtime test results. Detailed
historical sweep settings remain in [ModernBERT
documentation](modernbert/README.md).
