#!/usr/bin/env bash
#
# run_retry2.sh — Re-run failed benchmarks for mistral32 and qwen3_8b
#
# Previous retry failed due to 503/502 API errors.
# Missing benchmarks:
#   mistral32:  mmlu_pro, truthfulqa, arc_challenge, drop
#   qwen3_8b:   mmlu_pro, truthfulqa
#
# Usage:
#   ./run_retry2.sh             # Run retries
#   ./run_retry2.sh --dry-run   # Same but with --limit 5
#
set -eo pipefail

EVALS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DATE=$(date +%Y-%m-%d_%H%M)
STAGE2_DIR="${EVALS_DIR}/stage2"

# Auto-detect lm_eval
LM_EVAL=""
for candidate in \
    "$(dirname "${EVALS_DIR}")/.venv/bin/lm_eval" \
    "$(dirname "$(dirname "${EVALS_DIR}")")/.venv/bin/lm_eval" \
    "$(command -v lm_eval 2>/dev/null)"; do
    if [[ -x "${candidate}" ]]; then
        LM_EVAL="${candidate}"
        break
    fi
done
if [[ -z "${LM_EVAL}" ]]; then
    echo "ERROR: lm_eval not found."
    exit 1
fi

REGOLO_URL="https://api.regolo.ai/v1/chat/completions"

if [[ -z "${REGOLO_API_KEY:-}" ]]; then
    REGOLO_API_KEY="sk-NklmaM1W15f-FWYh8Li-mA"
    echo "==> Using built-in REGOLO_API_KEY."
fi

if ! command -v tmux &>/dev/null; then
    echo "ERROR: tmux is not installed."
    exit 1
fi

DRY_RUN=false
[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=true

DRY_RUN_FLAG=""
[[ "${DRY_RUN}" == "true" ]] && DRY_RUN_FLAG="--limit 5"

##############################################################################
# Quick API health check
##############################################################################

echo "==> Testing API connectivity ..."
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" \
    -H "Authorization: Bearer ${REGOLO_API_KEY}" \
    -H "Content-Type: application/json" \
    -d '{"model":"mistral-small3.2","messages":[{"role":"user","content":"hi"}],"max_tokens":1}' \
    "${REGOLO_URL}" 2>/dev/null || echo "000")

if [[ "${HTTP_CODE}" == "200" ]]; then
    echo "    API OK (HTTP ${HTTP_CODE})"
elif [[ "${HTTP_CODE}" == "000" ]]; then
    echo "    WARNING: API unreachable (connection failed)"
    echo "    Launching anyway — lm_eval has its own retry logic."
else
    echo "    WARNING: API returned HTTP ${HTTP_CODE}"
    echo "    Launching anyway — lm_eval has its own retry logic."
fi
echo ""

##############################################################################
# Kill old sessions for these models
##############################################################################

for s in eval-mistral32 eval-qwen3_8b; do
    if tmux has-session -t "${s}" 2>/dev/null; then
        tmux kill-session -t "${s}"
        echo "  Killed old session: ${s}"
    fi
done

##############################################################################
# Clean any partial results
##############################################################################

echo "==> Cleaning partial results ..."
for dir in \
    "${STAGE2_DIR}/mmlu_pro/mistral32" \
    "${STAGE2_DIR}/truthfulqa/mistral32" \
    "${STAGE2_DIR}/arc_challenge/mistral32" \
    "${STAGE2_DIR}/drop/mistral32" \
    "${STAGE2_DIR}/mmlu_pro/qwen3_8b" \
    "${STAGE2_DIR}/truthfulqa/qwen3_8b"; do
    if [[ -d "${dir}" ]]; then
        rm -rf "${dir:?}"/*
        echo "    Cleaned: ${dir}/"
    fi
done
echo ""

##############################################################################
# Generate & launch: mistral32 (4 benchmarks)
##############################################################################

cat > /tmp/eval_retry2_mistral32.sh <<'OUTER_EOF'
#!/usr/bin/env bash
set +e

export OPENAI_API_KEY="__REGOLO_API_KEY__"

PASSED=0; FAILED=0; SKIPPED=0

echo "========================================"
echo " RETRY2: mistral32"
echo " Benchmarks: mmlu_pro truthfulqa arc_challenge drop"
echo " Started: $(date)"
echo "========================================"

run_bench() {
    local label="$1" task="$2" outdir="$3" max_tokens="$4"
    shift 4
    echo ""
    echo "============================================================"
    echo "[RETRY2] mistral32 / ${task}"
    echo "  Started: $(date)"
    echo "============================================================"
    if find "${outdir}" -name "results*.json" -print -quit 2>/dev/null | grep -q .; then
        echo "[SKIP] results exist"; SKIPPED=$((SKIPPED+1)); return
    fi
    (cd /tmp && __LM_EVAL__ run \
        --model openai-chat-completions \
        --model_args "model=mistral-small3.2,base_url=https://api.regolo.ai/v1/chat/completions,tokenizer_backend=huggingface,tokenizer=mistralai/Mistral-Small-3.1-24B-Instruct-2503,stream=false,max_tokens=${max_tokens},temperature=0,top_p=1" \
        --tasks "${task}" \
        --output_path "${outdir}" \
        --log_samples --batch_size 1 --apply_chat_template --trust_remote_code \
        "$@" \
    ) && { echo "[DONE] mistral32 / ${task} — SUCCESS ($(date))"; PASSED=$((PASSED+1)); } \
      || { echo "[FAIL] mistral32 / ${task} — exit $? ($(date))"; FAILED=$((FAILED+1)); }
}

run_bench mmlu_pro mmlu_pro __STAGE2__/mmlu_pro/mistral32 2048 \
    --num_fewshot 5 --limit 500 --fewshot_as_multiturn True __DRY_RUN_FLAG__

run_bench truthfulqa truthfulqa_gen __STAGE2__/truthfulqa/mistral32 256 \
    __DRY_RUN_FLAG__

run_bench arc_challenge arc_challenge_chat __STAGE2__/arc_challenge/mistral32 256 \
    --gen_kwargs '{"until":["\n\nQuestion:"],"max_gen_toks":256}' __DRY_RUN_FLAG__

run_bench drop drop __STAGE2__/drop/mistral32 2048 \
    --num_fewshot 3 --limit 200 --fewshot_as_multiturn True \
    --gen_kwargs '{"until":["\n\n"]}' __DRY_RUN_FLAG__

echo ""
echo "========================================"
echo " RETRY2 complete: mistral32"
echo " Passed: ${PASSED} / Failed: ${FAILED} / Skipped: ${SKIPPED}"
echo " Finished: $(date)"
echo "========================================"
exec bash
OUTER_EOF

# Substitute placeholders
sed -i "s|__REGOLO_API_KEY__|${REGOLO_API_KEY}|g" /tmp/eval_retry2_mistral32.sh
sed -i "s|__LM_EVAL__|${LM_EVAL}|g"              /tmp/eval_retry2_mistral32.sh
sed -i "s|__STAGE2__|${STAGE2_DIR}|g"              /tmp/eval_retry2_mistral32.sh
sed -i "s|__DRY_RUN_FLAG__|${DRY_RUN_FLAG}|g"     /tmp/eval_retry2_mistral32.sh
chmod +x /tmp/eval_retry2_mistral32.sh

##############################################################################
# Generate & launch: qwen3_8b (2 benchmarks)
##############################################################################

cat > /tmp/eval_retry2_qwen3_8b.sh <<'OUTER_EOF'
#!/usr/bin/env bash
set +e

export OPENAI_API_KEY="__REGOLO_API_KEY__"

PASSED=0; FAILED=0; SKIPPED=0

echo "========================================"
echo " RETRY2: qwen3_8b"
echo " Benchmarks: mmlu_pro truthfulqa"
echo " Started: $(date)"
echo "========================================"

run_bench() {
    local label="$1" task="$2" outdir="$3" max_tokens="$4"
    shift 4
    echo ""
    echo "============================================================"
    echo "[RETRY2] qwen3_8b / ${task}"
    echo "  Started: $(date)"
    echo "============================================================"
    if find "${outdir}" -name "results*.json" -print -quit 2>/dev/null | grep -q .; then
        echo "[SKIP] results exist"; SKIPPED=$((SKIPPED+1)); return
    fi
    (cd /tmp && __LM_EVAL__ run \
        --model openai-chat-completions \
        --model_args "model=Qwen3-8B,base_url=https://api.regolo.ai/v1/chat/completions,tokenizer_backend=huggingface,tokenizer=Qwen/Qwen3-8B,stream=false,max_tokens=${max_tokens},temperature=0,top_p=1" \
        --tasks "${task}" \
        --output_path "${outdir}" \
        --log_samples --batch_size 1 --apply_chat_template --trust_remote_code \
        "$@" \
    ) && { echo "[DONE] qwen3_8b / ${task} — SUCCESS ($(date))"; PASSED=$((PASSED+1)); } \
      || { echo "[FAIL] qwen3_8b / ${task} — exit $? ($(date))"; FAILED=$((FAILED+1)); }
}

run_bench mmlu_pro mmlu_pro __STAGE2__/mmlu_pro/qwen3_8b 2048 \
    --num_fewshot 5 --limit 500 --fewshot_as_multiturn True __DRY_RUN_FLAG__

run_bench truthfulqa truthfulqa_gen __STAGE2__/truthfulqa/qwen3_8b 256 \
    __DRY_RUN_FLAG__

echo ""
echo "========================================"
echo " RETRY2 complete: qwen3_8b"
echo " Passed: ${PASSED} / Failed: ${FAILED} / Skipped: ${SKIPPED}"
echo " Finished: $(date)"
echo "========================================"
exec bash
OUTER_EOF

sed -i "s|__REGOLO_API_KEY__|${REGOLO_API_KEY}|g" /tmp/eval_retry2_qwen3_8b.sh
sed -i "s|__LM_EVAL__|${LM_EVAL}|g"              /tmp/eval_retry2_qwen3_8b.sh
sed -i "s|__STAGE2__|${STAGE2_DIR}|g"              /tmp/eval_retry2_qwen3_8b.sh
sed -i "s|__DRY_RUN_FLAG__|${DRY_RUN_FLAG}|g"     /tmp/eval_retry2_qwen3_8b.sh
chmod +x /tmp/eval_retry2_qwen3_8b.sh

##############################################################################
# Launch tmux sessions
##############################################################################

echo "==> Launching tmux sessions ..."

LOG_M="${STAGE2_DIR}/logs/mistral32_retry2_${DATE}.log"
LOG_Q="${STAGE2_DIR}/logs/qwen3_8b_retry2_${DATE}.log"

tmux new-session -d -s eval-mistral32 \
    "bash /tmp/eval_retry2_mistral32.sh 2>&1 | tee ${LOG_M}"
echo "  [OK] eval-mistral32  →  4 benchmarks  |  log: ${LOG_M}"

tmux new-session -d -s eval-qwen3_8b \
    "bash /tmp/eval_retry2_qwen3_8b.sh 2>&1 | tee ${LOG_Q}"
echo "  [OK] eval-qwen3_8b   →  2 benchmarks  |  log: ${LOG_Q}"

echo ""
echo "========================================"
echo " Retry2 Launcher"
echo " Date:     $(date)"
echo " Dry run:  ${DRY_RUN}"
echo " Sessions: 2 (mistral32, qwen3_8b)"
echo "========================================"
echo ""
echo "  ./check_status.sh        # monitor progress"
echo "  tmux attach -t eval-mistral32"
echo "  tmux attach -t eval-qwen3_8b"
echo ""
