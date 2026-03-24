#!/usr/bin/env bash
set -eo pipefail

EVALS_DIR="/root/forkGO/semantic-routing/evals"
VENV_PYTHON="/root/forkGO/semantic-routing/.venv/bin/python3"
REGOLO_URL="https://api.regolo.ai/v1/chat/completions"
REGOLO_API_KEY="${REGOLO_API_KEY:-sk-NklmaM1W15f-FWYh8Li-mA}"
TOKENIZER="Qwen/Qwen2.5-72B-Instruct"
MODEL_ID="qwen3.5-9b"
OUT_DIR="${EVALS_DIR}/stage8_large/qwen3.5-9b"
USAGE_LOG="${EVALS_DIR}/stage8_large/qwen3.5-9b_usage.jsonl"
LOG_FILE="${EVALS_DIR}/stage8_large/qwen3.5-9b.log"

mkdir -p "${OUT_DIR}"

run_lm_eval() {
    local MAX_TOKENS="$1"
    export OPENAI_API_KEY="${REGOLO_API_KEY}"
    export USAGE_LOG_PATH="${USAGE_LOG}"

    cd /tmp
    PYTHONPATH="${EVALS_DIR}" \
      "${VENV_PYTHON}" -c \
      'import patch_parse_generations; from lm_eval.__main__ import cli_evaluate; cli_evaluate()' \
      run \
      --model openai-chat-completions \
      --model_args "model=${MODEL_ID},base_url=${REGOLO_URL},tokenizer_backend=huggingface,tokenizer=${TOKENIZER},stream=false,max_tokens=${MAX_TOKENS},temperature=0,top_p=1" \
      --tasks brick_large \
      --include_path "${EVALS_DIR}/custom_tasks" \
      --output_path "${OUT_DIR}" \
      --log_samples \
      --batch_size 1 \
      --apply_chat_template \
      --trust_remote_code \
      --system_instruction 'For multiple choice questions, end your response with "the answer is (X)" where X is the letter.' \
      2>&1 | tee "${LOG_FILE}"
}

if run_lm_eval 4096; then
    echo "=== DONE (max_tokens=4096): ${MODEL_ID} ==="
else
    echo "[WARN] max_tokens=4096 failed, retrying with max_tokens=2048..."
    if run_lm_eval 2048; then
        echo "=== DONE (max_tokens=2048 fallback): ${MODEL_ID} ==="
    else
        echo "[ERROR] Both attempts failed for ${MODEL_ID}" >&2
        exit 1
    fi
fi

echo "Press Enter to close..."
read
