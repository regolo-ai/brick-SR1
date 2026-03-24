#!/usr/bin/env bash
# run_brick_v5.sh — brick model on brick_hard, max_tokens=16384 with fallback to 8192
set -eo pipefail

EVALS_DIR="/root/forkGO/semantic-routing/evals"
OUT_DIR="/root/forkGO/semantic-routing/evals/stage6_individual_hard_v5/brick"
LOG_FILE="${OUT_DIR}/brick.log"
USAGE_LOG="${OUT_DIR}/brick_usage.jsonl"

mkdir -p "${OUT_DIR}"

export OPENAI_API_KEY="${OPENAI_API_KEY:-sk-NklmaM1W15f-FWYh8Li-mA}"
export USAGE_LOG_PATH="${USAGE_LOG}"

run_lm_eval() {
    local MAX_TOKENS="$1"
    cd /tmp
    PYTHONPATH="${EVALS_DIR}" \
      "/root/forkGO/semantic-routing/.venv/bin/python3" -c \
      'import patch_parse_generations; from lm_eval.__main__ import cli_evaluate; cli_evaluate()' \
      run \
      --model openai-chat-completions \
      --model_args "model=brick,base_url=http://localhost:8000/v1/chat/completions,tokenizer_backend=huggingface,tokenizer=Qwen/Qwen2.5-72B-Instruct,stream=false,max_tokens=${MAX_TOKENS},temperature=0,top_p=1" \
      --tasks brick_hard \
      --include_path "${EVALS_DIR}/custom_tasks" \
      --output_path "${OUT_DIR}" \
      --log_samples \
      --batch_size 1 \
      --apply_chat_template \
      --trust_remote_code \
      --system_instruction 'For multiple choice questions, end your response with "the answer is (X)" where X is the letter.' \
      2>&1 | tee "${LOG_FILE}"
}

if run_lm_eval 16384; then
    echo "=== DONE (max_tokens=16384): brick ==="
else
    echo "[WARN] max_tokens=16384 failed, retrying with max_tokens=8192..."
    if run_lm_eval 8192; then
        echo "=== DONE (max_tokens=8192 fallback): brick ==="
    else
        echo "[ERROR] Both 16384 and 8192 failed for brick" >&2
        exit 1
    fi
fi

echo "Press Enter to close..."
read
