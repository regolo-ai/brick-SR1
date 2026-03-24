#!/usr/bin/env bash
set -eo pipefail

EVALS_DIR="/root/forkGO/semantic-routing/evals"
VENV_PYTHON="/root/forkGO/semantic-routing/.venv/bin/python3"
BRICK_URL="http://localhost:8000/v1/chat/completions"
TOKENIZER="Qwen/Qwen2.5-72B-Instruct"
OUT_DIR="${EVALS_DIR}/stage6_individual_hard_v5/brick"
USAGE_LOG="${EVALS_DIR}/stage6_individual_hard_v5/brick_usage.jsonl"
LOG_FILE="${EVALS_DIR}/stage6_individual_hard_v5/brick.log"

export OPENAI_API_KEY="sk-NklmaM1W15f-FWYh8Li-mA"
export USAGE_LOG_PATH="${USAGE_LOG}"

run_lm_eval() {
    local MAX_TOKENS="$1"
    cd /tmp
    PYTHONPATH="${EVALS_DIR}" \
      "${VENV_PYTHON}" -c \
      'import patch_parse_generations; from lm_eval.__main__ import cli_evaluate; cli_evaluate()' \
      run \
      --model openai-chat-completions \
      --model_args "model=brick,base_url=${BRICK_URL},tokenizer_backend=huggingface,tokenizer=${TOKENIZER},stream=false,max_tokens=${MAX_TOKENS},temperature=0,top_p=1" \
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
    echo "[WARN] 16384 failed, retry 8192..."
    if run_lm_eval 8192; then
        echo "=== DONE (max_tokens=8192 fallback): brick ==="
    else
        echo "[ERROR] Both failed" >&2; exit 1
    fi
fi

echo "Press Enter to close..."
read
