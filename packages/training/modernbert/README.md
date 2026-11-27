# ModernBERT capability training

This pipeline trains a six-output sigmoid classifier on
`massaindustries/dataset-B-modernbert-train`. Training does not change the npm
release checkpoint. See the [workspace guide](../README.md) for locked dependency
installation, credentials, Dataset B generation and the release boundary.

## Local smoke and sweeps

From the repository root, with GPU capacity and dataset access:

```bash
uv sync --frozen --package brick-training
uv run --frozen --package brick-training python packages/training/modernbert/scripts/train_modernbert.py --smoke --model_size base --no_wandb
```

For sweeps, run `wandb sweep configs/sweep.yaml` and the resulting agent through
`uv run --frozen --package brick-training` from this directory. The scheduler
must assign GPUs to each agent. `sky/train.yaml` is only for provisioning new
external capacity and runs a single-GPU smoke job.

## Checkpoint selection and export

Run these tools through the same locked environment from this directory:

```bash
python scripts/select_top3.py --project ENTITY/PROJECT --sweep SWEEP_ID
python scripts/eval_human.py --ckpt outputs/top3/rank1/best --output outputs/top3/rank1/eval_human.json
python scripts/sanity_check.py --ckpt outputs/top3/rank1/best
python scripts/export_for_candle.py --ckpt outputs/top3/rank1/best --output outputs/modernbert-winner/best
python scripts/bench_latency.py --ckpt outputs/modernbert-winner/best
```

Human evaluation requires an annotated CSV, accepted via `--human-eval-csv`.
`manual_annotate_200.py` prepares annotation with an external judge.
`push_winner.py --ckpt PATH --repo OWNER/REPOSITORY` explicitly publishes a
checkpoint; it is never run during install, build or CI.

## Training settings

The script uses PyTorch SDPA, bf16 on CUDA, seed 42, a maximum sequence length of
512 and early stopping on `pearson_macro`. The sweep varies model size, learning
rate, weight decay, warmup and epoch count. CPU execution disables bf16.
Measured model quality and latency must come from a completed experiment;
o historical target or sweep setting is a release acceptance result.
