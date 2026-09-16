#!/bin/bash
# Run V3 honest 3way multi-seed for each complexity model debug file
# Usage: ./sweep_complexity_models.sh
set -e

repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$repo_dir"
: "${WANDB_API_KEY:?Set WANDB_API_KEY before launching the sweep}"
output_dir="${BRICK_BASELINE_OUTPUT:-./baseline-output}"
mkdir -p "$output_dir"

for MODEL in eco max extractor; do
  if [ "$MODEL" = "eco" ]; then
    INPUT="${output_dir}/brick_debug_gpu.jsonl"
  else
    INPUT="${output_dir}/brick_debug_${MODEL}.jsonl"
  fi
  if [ ! -f "$INPUT" ]; then
    echo "[skip] $MODEL: input $INPUT missing"
    continue
  fi
  echo "[run] complexity_model=$MODEL input=$INPUT"
  for SEED in alpha beta gamma delta epsilon; do
    nohup python3 packages/evals/baselines/eval_brick_3way.py \
      --input "$INPUT" \
      --mode v3_random --trials 30000 \
      --seed brick-3way-${MODEL}-${SEED} \
      --run-name 3way-v3-${MODEL}-${SEED} \
      --out "${output_dir}/brick_3way_v3_${MODEL}_${SEED}.json" \
      > /tmp/brick_3way_v3_${MODEL}_${SEED}.log 2>&1 &
    echo "  ${MODEL}-${SEED} PID: $!"
  done
done
echo "all launched"
