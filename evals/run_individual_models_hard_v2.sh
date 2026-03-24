#!/usr/bin/env bash
# run_individual_models_hard_v2.sh — Run brick_hard v2 (patched dataset) on 4 models
set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EVALS_DIR="${SCRIPT_DIR}"
VENV_PYTHON="/root/forkGO/semantic-routing/.venv/bin/python3"
REGOLO_URL="https://api.regolo.ai/v1/chat/completions"
REGOLO_API_KEY="${REGOLO_API_KEY:?ERROR: REGOLO_API_KEY not set}"
TOKENIZER="Qwen/Qwen2.5-72B-Instruct"
STAGE_DIR="${EVALS_DIR}/stage6_individual_hard_v2"
TMUX_SESSION="evals-hard-v2"
TMPDIR_SCRIPTS="${STAGE_DIR}/.scripts"

mkdir -p "${STAGE_DIR}" "${TMPDIR_SCRIPTS}"
# Skip Llama (rate-limited) and qwen3-8b (alias)
MODELS=("qwen3-coder-next" "mistral-small3.2" "gpt-oss-120b" "qwen3-8b")

tmux kill-session -t "${TMUX_SESSION}" 2>/dev/null || true

for model_id in "${MODELS[@]}"; do
    safe_name="${model_id//\//_}"
    out_dir="${STAGE_DIR}/${safe_name}"
    usage_log="${STAGE_DIR}/${safe_name}_usage.jsonl"
    log_file="${STAGE_DIR}/${safe_name}.log"
    runner="${TMPDIR_SCRIPTS}/run_${safe_name}.sh"
    mkdir -p "${out_dir}"

    cat > "${runner}" << 'HEREDOC_END'
#!/usr/bin/env bash
set -eo pipefail
HEREDOC_END

    cat >> "${runner}" << HEREDOC_END
export OPENAI_API_KEY="${REGOLO_API_KEY}"
export USAGE_LOG_PATH="${usage_log}"

cd /tmp
PYTHONPATH="${EVALS_DIR}" \\
  "${VENV_PYTHON}" -c \\
  'import patch_parse_generations; from lm_eval.__main__ import cli_evaluate; cli_evaluate()' \\
  run \\
  --model openai-chat-completions \\
  --model_args 'model=${model_id},base_url=${REGOLO_URL},tokenizer_backend=huggingface,tokenizer=${TOKENIZER},stream=false,max_tokens=2048,temperature=0,top_p=1' \\
  --tasks brick_hard \\
  --include_path '${EVALS_DIR}/custom_tasks' \\
  --output_path '${out_dir}' \\
  --log_samples \\
  --batch_size 1 \\
  --apply_chat_template \\
  --trust_remote_code \\
  --system_instruction 'For multiple choice questions, end your response with "the answer is (X)" where X is the letter.' \\
  2>&1 | tee '${log_file}'

echo "=== DONE: ${model_id} ==="
echo "Press Enter to close..."
read
HEREDOC_END
    chmod +x "${runner}"
done

FIRST=true
for model_id in "${MODELS[@]}"; do
    safe_name="${model_id//\//_}"
    runner="${TMPDIR_SCRIPTS}/run_${safe_name}.sh"
    if [ "${FIRST}" = true ]; then
        tmux new-session -d -s "${TMUX_SESSION}" -n "${safe_name}" "bash ${runner}"
        FIRST=false; sleep 1
    else
        tmux new-window -t "${TMUX_SESSION}" -n "${safe_name}" "bash ${runner}"; sleep 0.5
    fi
    echo "[LAUNCH] ${model_id} → ${TMUX_SESSION}:${safe_name}"
done

echo ""
echo "=== v2 evals launched. Results: ${STAGE_DIR}/ ==="
