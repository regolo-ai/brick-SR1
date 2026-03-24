#!/usr/bin/env bash
set -eo pipefail

run_lm_eval() {
    local MAX_TOKENS="$1"
    export OPENAI_API_KEY="sk-NklmaM1W15f-FWYh8Li-mA"
    export USAGE_LOG_PATH="/root/forkGO/semantic-routing/evals/stage8_large_v2/mistral-small-4-119b_usage.jsonl"

    cd /tmp
    PYTHONPATH="/root/forkGO/semantic-routing/evals" \
      "/root/forkGO/semantic-routing/.venv/bin/python3" -c \
      'import patch_parse_generations; from lm_eval.__main__ import cli_evaluate; cli_evaluate()' \
      run \
      --model openai-chat-completions \
      --model_args "model=mistral-small-4-119b,base_url=https://api.regolo.ai/v1/chat/completions,tokenizer_backend=huggingface,tokenizer=Qwen/Qwen2.5-72B-Instruct,stream=false,max_tokens=${MAX_TOKENS},temperature=0,top_p=1" \
      --tasks brick_large \
      --include_path '/root/forkGO/semantic-routing/evals/custom_tasks' \
      --output_path '/root/forkGO/semantic-routing/evals/stage8_large_v2/mistral-small-4-119b' \
      --log_samples \
      --batch_size 1 \
      --apply_chat_template \
      --trust_remote_code \
      --system_instruction 'For multiple choice questions, end your response with "the answer is (X)" where X is the letter.' \
      2>&1 | tee '/root/forkGO/semantic-routing/evals/stage8_large_v2/mistral-small-4-119b.log'
}

if run_lm_eval 16384; then
    echo "=== DONE (max_tokens=16384): mistral-small-4-119b ==="
else
    echo "[WARN] max_tokens=16384 failed, retrying with max_tokens=8192..."
    if run_lm_eval 8192; then
        echo "=== DONE (max_tokens=8192 fallback): mistral-small-4-119b ==="
    else
        echo "[ERROR] Both 16384 and 8192 failed for mistral-small-4-119b" >&2
        exit 1
    fi
fi

echo "Press Enter to close..."
read
