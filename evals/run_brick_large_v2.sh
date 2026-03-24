#!/usr/bin/env bash
# run_brick_large_v2.sh — Run brick_large (2000 questions) via Brick gateway (v2 config)
# Launches a dedicated tmux session: large-v2-brick
# Results → evals/stage8_large_v2/brick/
set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EVALS_DIR="${SCRIPT_DIR}"
VENV_PYTHON="/root/forkGO/semantic-routing/.venv/bin/python3"
BRICK_URL="http://213.171.186.210:8000/v1/chat/completions"
REGOLO_API_KEY="${REGOLO_API_KEY:?ERROR: REGOLO_API_KEY not set}"
TOKENIZER="Qwen/Qwen2.5-72B-Instruct"
STAGE_DIR="${EVALS_DIR}/stage8_large_v2"
TMPDIR_SCRIPTS="${STAGE_DIR}/.scripts"
SESSION="large-v2-brick"

mkdir -p "${STAGE_DIR}/brick" "${TMPDIR_SCRIPTS}"

OUT_DIR="${STAGE_DIR}/brick"
USAGE_LOG="${STAGE_DIR}/brick_usage.jsonl"
LOG_FILE="${STAGE_DIR}/brick.log"
RUNNER="${TMPDIR_SCRIPTS}/run_brick.sh"

cat > "${RUNNER}" << 'HEREDOC_END'
#!/usr/bin/env bash
set -eo pipefail

run_lm_eval() {
    local MAX_TOKENS="$1"
HEREDOC_END

cat >> "${RUNNER}" << HEREDOC_END
    export OPENAI_API_KEY="${REGOLO_API_KEY}"
    export USAGE_LOG_PATH="${USAGE_LOG}"

    cd /tmp
    PYTHONPATH="${EVALS_DIR}" \\
      "${VENV_PYTHON}" -c \\
      'import patch_parse_generations; from lm_eval.__main__ import cli_evaluate; cli_evaluate()' \\
      run \\
      --model openai-chat-completions \\
      --model_args "model=brick,base_url=${BRICK_URL},tokenizer_backend=huggingface,tokenizer=${TOKENIZER},stream=false,max_tokens=\${MAX_TOKENS},temperature=0,top_p=1" \\
      --tasks brick_large \\
      --include_path '${EVALS_DIR}/custom_tasks' \\
      --output_path '${OUT_DIR}' \\
      --log_samples \\
      --batch_size 1 \\
      --apply_chat_template \\
      --trust_remote_code \\
      --system_instruction 'For multiple choice questions, end your response with "the answer is (X)" where X is the letter.' \\
      2>&1 | tee '${LOG_FILE}'
}

if run_lm_eval 16384; then
    echo "=== DONE (max_tokens=16384): brick/brick_large ==="
else
    echo "[WARN] max_tokens=16384 failed, retrying with max_tokens=8192..."
    if run_lm_eval 8192; then
        echo "=== DONE (max_tokens=8192 fallback): brick/brick_large ==="
    else
        echo "[ERROR] Both attempts failed for brick/brick_large" >&2
        exit 1
    fi
fi

echo "Press Enter to close..."
read
HEREDOC_END
chmod +x "${RUNNER}"

# Kill stale session
tmux kill-session -t "${SESSION}" 2>/dev/null || true
sleep 0.3

tmux new-session -d -s "${SESSION}" "bash ${RUNNER}"

echo "[LAUNCH] Brick v2 → tmux attach -t ${SESSION}"
echo "Results: ${OUT_DIR}/"
echo "Usage log: ${USAGE_LOG}"
