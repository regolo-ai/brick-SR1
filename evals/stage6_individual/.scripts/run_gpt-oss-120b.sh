#!/usr/bin/env bash
set -eo pipefail
export OPENAI_API_KEY="sk-NklmaM1W15f-FWYh8Li-mA"
export USAGE_LOG_PATH="/root/forkGO/semantic-routing/evals/stage6_individual/gpt-oss-120b_usage.jsonl"

cd /tmp
PYTHONPATH="/root/forkGO/semantic-routing/evals" \
  "/root/forkGO/semantic-routing/.venv/bin/python3" -c \
  'import patch_parse_generations; from lm_eval.__main__ import cli_evaluate; cli_evaluate()' \
  run \
  --model openai-chat-completions \
  --model_args 'model=gpt-oss-120b,base_url=https://api.regolo.ai/v1/chat/completions,tokenizer_backend=huggingface,tokenizer=Qwen/Qwen2.5-72B-Instruct,stream=false,max_tokens=2048,temperature=0,top_p=1' \
  --tasks brick_general \
  --include_path '/root/forkGO/semantic-routing/evals/custom_tasks' \
  --output_path '/root/forkGO/semantic-routing/evals/stage6_individual/gpt-oss-120b' \
  --log_samples \
  --batch_size 1 \
  --apply_chat_template \
  --trust_remote_code \
  --system_instruction 'For multiple choice questions, end your response with "the answer is (X)" where X is the letter.' \
  2>&1 | tee '/root/forkGO/semantic-routing/evals/stage6_individual/gpt-oss-120b.log'

echo ""
echo "=== DONE: gpt-oss-120b ==="

# Generate per-model cost summary
if [[ -f "/root/forkGO/semantic-routing/evals/stage6_individual/gpt-oss-120b_usage.jsonl" ]]; then
    python3 "/root/forkGO/semantic-routing/evals/summarize_costs.py" \
        --usage "/root/forkGO/semantic-routing/evals/stage6_individual/gpt-oss-120b_usage.jsonl" \
        --results-dir "/root/forkGO/semantic-routing/evals/stage6_individual/gpt-oss-120b" \
        --output "/root/forkGO/semantic-routing/evals/stage6_individual/gpt-oss-120b_cost_summary.json" \
    || echo "[WARN] Cost summary failed for gpt-oss-120b"
fi

echo "Press Enter to close..."
read
