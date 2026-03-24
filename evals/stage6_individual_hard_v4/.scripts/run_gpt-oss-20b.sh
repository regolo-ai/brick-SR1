#!/usr/bin/env bash
set -eo pipefail
export OPENAI_API_KEY="sk-NklmaM1W15f-FWYh8Li-mA"
export USAGE_LOG_PATH="/root/forkGO/semantic-routing/evals/stage6_individual_hard_v4/gpt-oss-20b_usage.jsonl"

cd /tmp
PYTHONPATH="/root/forkGO/semantic-routing/evals" \
  "/root/forkGO/semantic-routing/.venv/bin/python3" -c \
  'import patch_parse_generations; from lm_eval.__main__ import cli_evaluate; cli_evaluate()' \
  run \
  --model openai-chat-completions \
  --model_args 'model=gpt-oss-20b,base_url=https://api.regolo.ai/v1/chat/completions,tokenizer_backend=huggingface,tokenizer=Qwen/Qwen2.5-72B-Instruct,stream=false,max_tokens=2048,temperature=0,top_p=1' \
  --tasks brick_hard \
  --include_path '/root/forkGO/semantic-routing/evals/custom_tasks' \
  --output_path '/root/forkGO/semantic-routing/evals/stage6_individual_hard_v4/gpt-oss-20b' \
  --log_samples \
  --batch_size 1 \
  --apply_chat_template \
  --trust_remote_code \
  --system_instruction 'For multiple choice questions, end your response with "the answer is (X)" where X is the letter.' \
  2>&1 | tee '/root/forkGO/semantic-routing/evals/stage6_individual_hard_v4/gpt-oss-20b.log'

echo "=== DONE: gpt-oss-20b ==="
echo "Press Enter to close..."
read
