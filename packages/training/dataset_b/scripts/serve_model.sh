#!/usr/bin/env bash
# Use an operator-provisioned vLLM GPU environment. Never stop unrelated servers.
# Usage: serve_model.sh MODEL_REPOSITORY [additional vllm serve options]
set -euo pipefail
MODEL_REPOSITORY="${1:?Usage: serve_model.sh MODEL_REPOSITORY [options]}"
shift
command -v vllm >/dev/null
exec vllm serve "$MODEL_REPOSITORY" --tensor-parallel-size 4 \
  --gpu-memory-utilization 0.85 --max-model-len 8192 --max-num-seqs 128 \
  --host 127.0.0.1 --port 30000 "$@"
