#!/usr/bin/env bash
# run_individual_models_large.sh — Run brick_large (2000 MMLU-Pro questions, 400/category)
# Launches ONE dedicated tmux session per model for easy parallel monitoring.
# Results → evals/stage8_large/{model}/
set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EVALS_DIR="${SCRIPT_DIR}"
VENV_PYTHON="/root/forkGO/semantic-routing/.venv/bin/python3"
REGOLO_URL="https://api.regolo.ai/v1/chat/completions"
REGOLO_API_KEY="${REGOLO_API_KEY:?ERROR: REGOLO_API_KEY not set}"
TOKENIZER="Qwen/Qwen2.5-72B-Instruct"
STAGE_DIR="${EVALS_DIR}/stage8_large"
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

# ── Generate per-model runner scripts ────────────────────────────────────────
for model_id in "${MODELS[@]}"; do
    safe_name="${model_id//\//_}"
    out_dir="${STAGE_DIR}/${safe_name}"
    usage_log="${STAGE_DIR}/${safe_name}_usage.jsonl"
    log_file="${STAGE_DIR}/${safe_name}.log"
    runner="${TMPDIR_SCRIPTS}/run_${safe_name}.sh"
    mkdir -p "${out_dir}"

    # gpt-oss-120b uses reasoning_effort=high
    extra_model_args=""
    if [ "${model_id}" = "gpt-oss-120b" ]; then
        extra_model_args=",reasoning_effort=high"
    fi

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
      --model_args "model=${model_id},base_url=${REGOLO_URL},tokenizer_backend=huggingface,tokenizer=${TOKENIZER},stream=false,max_tokens=\${MAX_TOKENS},temperature=0,top_p=1${extra_model_args}" \\
      --tasks brick_large \\
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

# ── Launch one dedicated tmux session per model ───────────────────────────────
for model_id in "${MODELS[@]}"; do
    safe_name="${model_id//\//_}"
    session="large-${safe_name}"
    runner="${TMPDIR_SCRIPTS}/run_${safe_name}.sh"

    # Kill stale session if present
    tmux kill-session -t "${session}" 2>/dev/null || true
    sleep 0.3

    tmux new-session -d -s "${session}" "bash ${runner}"
    echo "[LAUNCH] ${model_id}  →  tmux attach -t ${session}"
done

echo ""
echo "=== brick_large evals launched (2000q, 400/cat, 6 models, max_tokens=16384) ==="
echo "Results dir: ${STAGE_DIR}/"
echo ""
echo "Monitor individual sessions:"
for model_id in "${MODELS[@]}"; do
    safe_name="${model_id//\//_}"
    echo "  tmux attach -t large-${safe_name}"
done
