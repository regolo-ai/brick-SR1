#!/usr/bin/env bash
#
# run_individual_models.sh — Run brick_general eval on each model directly via Regolo API
#
set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EVALS_DIR="${SCRIPT_DIR}"
VENV_PYTHON="/root/forkGO/semantic-routing/.venv/bin/python3"
REGOLO_URL="https://api.regolo.ai/v1/chat/completions"
REGOLO_API_KEY="${REGOLO_API_KEY:?ERROR: REGOLO_API_KEY not set}"
TOKENIZER="Qwen/Qwen2.5-72B-Instruct"
STAGE_DIR="${EVALS_DIR}/stage6_individual"
TMUX_SESSION="evals-individual"
TMPDIR_SCRIPTS="${STAGE_DIR}/.scripts"

mkdir -p "${STAGE_DIR}" "${TMPDIR_SCRIPTS}"

# Models to test
MODELS=("qwen3-coder-next" "Llama-3.3-70B-Instruct" "mistral-small3.2" "gpt-oss-120b" "qwen3-8b")

# Kill existing session
tmux kill-session -t "${TMUX_SESSION}" 2>/dev/null || true

# Generate per-model runner scripts using heredoc (avoids quoting hell)
for model_id in "${MODELS[@]}"; do
    safe_name="${model_id//\//_}"
    out_dir="${STAGE_DIR}/${safe_name}"
    usage_log="${STAGE_DIR}/${safe_name}_usage.jsonl"
    log_file="${STAGE_DIR}/${safe_name}.log"
    runner="${TMPDIR_SCRIPTS}/run_${safe_name}.sh"

    # Skip if results already exist
    if find "${out_dir}" -name "results*.json" -print -quit 2>/dev/null | grep -q .; then
        echo "[SKIP] ${model_id} — results exist in ${out_dir}"
        continue
    fi

    mkdir -p "${out_dir}"

    # Write runner using heredoc with single-quoted delimiter (no variable expansion)
    cat > "${runner}" << 'HEREDOC_END'
#!/usr/bin/env bash
set -eo pipefail
HEREDOC_END

    # Append the variable parts
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
  --tasks brick_general \\
  --include_path '${EVALS_DIR}/custom_tasks' \\
  --output_path '${out_dir}' \\
  --log_samples \\
  --batch_size 1 \\
  --apply_chat_template \\
  --trust_remote_code \\
  --system_instruction 'For multiple choice questions, end your response with "the answer is (X)" where X is the letter.' \\
  2>&1 | tee '${log_file}'

echo ""
echo "=== DONE: ${model_id} ==="

# Generate per-model cost summary
if [[ -f "${usage_log}" ]]; then
    python3 "${EVALS_DIR}/summarize_costs.py" \\
        --usage "${usage_log}" \\
        --results-dir "${out_dir}" \\
        --output "${STAGE_DIR}/${safe_name}_cost_summary.json" \\
    || echo "[WARN] Cost summary failed for ${model_id}"
fi

echo "Press Enter to close..."
read
HEREDOC_END

    chmod +x "${runner}"
done

# Create tmux session with sleep to ensure stability
FIRST=true
for model_id in "${MODELS[@]}"; do
    safe_name="${model_id//\//_}"
    runner="${TMPDIR_SCRIPTS}/run_${safe_name}.sh"

    if [[ ! -f "${runner}" ]]; then
        continue
    fi

    if [ "${FIRST}" = true ]; then
        tmux new-session -d -s "${TMUX_SESSION}" -n "${safe_name}" "bash ${runner}"
        FIRST=false
        sleep 1  # let session stabilize
    else
        tmux new-window -t "${TMUX_SESSION}" -n "${safe_name}" "bash ${runner}"
        sleep 0.5
    fi
    echo "[LAUNCH] ${model_id} → tmux:${TMUX_SESSION}:${safe_name}"
done

echo ""
echo "========================================"
echo " 5 models launched in tmux: ${TMUX_SESSION}"
echo " Attach: tmux attach -t ${TMUX_SESSION}"
echo " Results: ${STAGE_DIR}/"
echo "========================================"
