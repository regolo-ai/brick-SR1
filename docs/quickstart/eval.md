# Evaluate routing and model quality

Evaluation is a development workflow. It needs Python, external datasets and,
for inference and judging, provider credentials. npm installation runs none of
these paid experiments. Historical paper scores are not guaranteed by a new
run with changing APIs or datasets.

## Install and check offline components

From the repository root:

```bash
uv sync --frozen --all-packages
python3 scripts/bootstrap_eval_sources.py
make test-python
```

The bootstrap fetches pinned BFCL grader source. Dataset/report checks run
separately with `make test-python-data` after generating their inputs; missing
inputs fail that target.

## Download development inputs

```bash
uv run --frozen python packages/datasets/scripts/download_dataset_a.py --out ./data/dataset_a
uv run --frozen python packages/datasets/scripts/download_models.py --out ./models
```

The model command installs only the pinned ModernBERT capability checkpoint
under `models/modernbert-capability-classifier`. The complexity classifier is
an API endpoint configured in the Brick profile. npm users already receive
ModernBERT during installation.

## Run inference

Create and start an evaluation profile using the
[profile workflow](serve.md). Use the actual port from that profile. The
inference script requires a model alias from `packages/evals/configs/models.yaml`
even when overriding the upstream model identifier:

```bash
uv run --frozen python packages/evals/scripts/100_run_inference.py   --model deepseek-v4-flash --model-id-override brick   --endpoint-url http://127.0.0.1:8000/v1   --dataset ./data/dataset_a/evaluation_parameters_full.jsonl   --limit-per-dim 2 --output ./runs/brick.jsonl
```

Confirm the downloaded evaluation JSONL path before running. Configure any
required local authentication with the script's `--endpoint-key` option.
Use `--help` for dimension selection, reasoning, concurrency and budget options.
Planning/BFCL multi-turn evaluation has its own entrypoint:
`packages/evals/scripts/120_run_bfcl_multi_turn.py`.

## Grade and aggregate

```bash
uv run --frozen python packages/evals/scripts/110_grade_inference.py   --inference ./runs/brick.jsonl   --dataset ./data/dataset_a/evaluation_parameters_full.jsonl   --output ./runs/graded.jsonl
```

This runs deterministic graders. LLM grading requires `--enable-judge` and
provider credentials. Run once per judge with distinct output files, then
aggregate at least two graded files:

```bash
uv run --frozen python packages/evals/scripts/115_aggregate_panel.py   --inputs ./runs/judge-a.jsonl ./runs/judge-b.jsonl ./runs/judge-c.jsonl   --output ./runs/panel.jsonl
```

See the [evaluation pipeline](../../packages/evals/README.md),
[comparison runners](../../packages/evals/baselines/README.md) and
[training workflows](../../packages/training/README.md) for their input
contracts. External model execution and publication are explicit operations,
separate from offline CI.
