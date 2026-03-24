#!/usr/bin/env bash
# run_individual_models_mixed.sh — Run brick_mixed (200 questions, 100 easy + 100 hard) on all 6 models
# Saves results to evals/stage7_mixed/{model}/
set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EVALS_DIR="${SCRIPT_DIR}"
VENV_PYTHON="/root/forkGO/semantic-routing/.venv/bin/python3"
REGOLO_URL="https://api.regolo.ai/v1/chat/completions"
REGOLO_API_KEY="${REGOLO_API_KEY:?ERROR: REGOLO_API_KEY not set}"
TOKENIZER="Qwen/Qwen2.5-72B-Instruct"
STAGE_DIR="${EVALS_DIR}/stage7_mixed"
TMUX_SESSION="evals-mixed"
TMPDIR_SCRIPTS="${STAGE_DIR}/.scripts"

mkdir -p "${STAGE_DIR}" "${TMPDIR_SCRIPTS}"

MODELS=(
    "gpt-oss-120b"
    "gpt-oss-20b"
    "qwen3-8b"
    "Llama-3.3-70B-Instruct"
    "mistral-small3.2"
    "qwen3-coder-next"
)

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

run_lm_eval() {
    local MAX_TOKENS="$1"
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
      --model_args "model=${model_id},base_url=${REGOLO_URL},tokenizer_backend=huggingface,tokenizer=${TOKENIZER},stream=false,max_tokens=\${MAX_TOKENS},temperature=0,top_p=1" \\
      --tasks brick_mixed \\
      --include_path '${EVALS_DIR}/custom_tasks' \\
      --output_path '${out_dir}' \\
      --log_samples \\
      --batch_size 1 \\
      --apply_chat_template \\
      --trust_remote_code \\
      --system_instruction 'For multiple choice questions, end your response with "the answer is (X)" where X is the letter.' \\
      2>&1 | tee '${log_file}'
}

if run_lm_eval 16384; then
    echo "=== DONE (max_tokens=16384): ${model_id} ==="
else
    echo "[WARN] max_tokens=16384 failed, retrying with max_tokens=8192..."
    if run_lm_eval 8192; then
        echo "=== DONE (max_tokens=8192 fallback): ${model_id} ==="
    else
        echo "[ERROR] Both 16384 and 8192 failed for ${model_id}" >&2
        exit 1
    fi
fi

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
echo "=== mixed evals launched (200 questions, 6 models, max_tokens=16384). Results: ${STAGE_DIR}/ ==="
echo "Monitor: tmux attach -t ${TMUX_SESSION}"
