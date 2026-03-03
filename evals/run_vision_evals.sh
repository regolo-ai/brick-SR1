#!/usr/bin/env bash
#
# run_vision_evals.sh — Vision Evals: lmms-eval benchmarks for Brick vs qwen3-vl-32b
#
# Usage:
#   ./run_vision_evals.sh                         # Run all benchmarks
#   ./run_vision_evals.sh --dry-run               # Dry run with --limit 2
#   ./run_vision_evals.sh --only brick            # Run only for brick
#   ./run_vision_evals.sh --only qwen3vl32b       # Run only for qwen3-vl-32b
#
# Prerequisites:
#   - lmms-eval installed in .venv-vision
#   - Brick Docker container running on the eval server
#   - REGOLO_API_KEY env var set
#
set -eo pipefail

##############################################################################
# Configuration
##############################################################################

EVALS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STAGE3_DIR="${EVALS_DIR}/stage3"
LOGS_DIR="${STAGE3_DIR}/logs"
DATE=$(date +%Y-%m-%d)

# Auto-detect lmms_eval binary
LMMS_EVAL=""
for candidate in \
    "$(dirname "${EVALS_DIR}")/.venv-vision/bin/lmms_eval" \
    "$(dirname "$(dirname "${EVALS_DIR}")")/.venv-vision/bin/lmms_eval" \
    "$(command -v lmms_eval 2>/dev/null)"; do
    if [[ -x "${candidate}" ]]; then
        LMMS_EVAL="${candidate}"
        break
    fi
done
if [[ -z "${LMMS_EVAL}" ]]; then
    echo "ERROR: lmms_eval not found. Install it in .venv-vision or activate the venv."
    exit 1
fi

# Brick gateway (running on dedicated eval server) — no /chat/completions suffix
BRICK_URL="http://213.171.186.210:8000/v1"

# Regolo API — for qwen3-vl-32b baseline — no /chat/completions suffix
REGOLO_URL="https://api.regolo.ai/v1"

# Parallel arrays: index 0 = brick, 1 = qwen3-vl-32b
SHORT_NAMES=(brick qwen3vl32b)
MODELS=(brick qwen3-vl-32b)

##############################################################################
# CLI arguments
##############################################################################

DRY_RUN=false
ONLY_MODEL=""

while [[ $# -gt 0 ]]; do
    case $1 in
        --dry-run) DRY_RUN=true; shift ;;
        --only)    ONLY_MODEL="$2"; shift 2 ;;
        -h|--help)
            head -14 "${BASH_SOURCE[0]}" | tail -12
            exit 0
            ;;
        *) echo "Unknown option: $1"; exit 1 ;;
    esac
done

# REGOLO_API_KEY is always required (brick gateway forwards it to Regolo API)
if [[ -z "${REGOLO_API_KEY:-}" ]]; then
    echo "ERROR: REGOLO_API_KEY is not set."
    echo "Export it before running: export REGOLO_API_KEY=sk-..."
    exit 1
fi

# lmms-eval's openai model reads API key from OPENAI_API_KEY env var
export OPENAI_API_KEY="${REGOLO_API_KEY}"

mkdir -p "${LOGS_DIR}"

##############################################################################
# Counters
##############################################################################

TOTAL_RUN=0
TOTAL_SKIP=0
TOTAL_FAIL=0

##############################################################################
# Core function
##############################################################################

run_vision_eval() {
    local idx=$1
    local task=$2
    local output_subdir=$3
    local max_tokens=$4

    local short="${SHORT_NAMES[$idx]}"
    local model="${MODELS[$idx]}"
    local out_dir="${STAGE3_DIR}/${output_subdir}/${short}"
    local log_file="${LOGS_DIR}/${short}_${task//,/_}_${DATE}.log"

    # --only filter
    if [[ -n "${ONLY_MODEL}" && "${short}" != "${ONLY_MODEL}" ]]; then
        return 0
    fi

    # Idempotency: skip if results already exist
    if find "${out_dir}" -name "results*.json" -print -quit 2>/dev/null | grep -q .; then
        echo "[SKIP] ${short} / ${task} — results exist in ${out_dir}"
        (( TOTAL_SKIP++ )) || true
        return 0
    fi

    mkdir -p "${out_dir}"

    # Build base URL based on model
    local base_url
    if [[ $idx -eq 0 ]]; then
        base_url="${BRICK_URL}"
    else
        base_url="${REGOLO_URL}"
    fi

    # Build model_args (lmms-eval openai model uses model_version for model name)
    local model_args="model_version=${model},base_url=${base_url},timeout=120,max_retries=10"

    # Build extra flags
    local -a extra_flags=()

    # Dry run: append --limit 2
    if [[ "${DRY_RUN}" == "true" ]]; then
        extra_flags+=(--limit 2)
    fi

    echo "============================================================"
    echo "[RUN] ${short} / ${task}"
    echo "  Model: openai (${model})"
    echo "  Base URL: ${base_url}"
    echo "  Max tokens: ${max_tokens}"
    echo "  Output: ${out_dir}"
    echo "  Log: ${log_file}"
    echo "  Started: $(date)"
    echo "============================================================"

    # Run lmms-eval from /tmp to avoid CWD directory names colliding with task names.
    # Use "|| true" to prevent set -e from killing the script on failure.
    (cd /tmp && "${LMMS_EVAL}" eval \
        --model openai \
        --model_args "${model_args}" \
        --tasks "${task}" \
        --max_tokens "${max_tokens}" \
        --output_path "${out_dir}" \
        --log_samples \
        --batch_size 1 \
        ${extra_flags[@]+"${extra_flags[@]}"} \
    ) 2>&1 | tee "${log_file}" || true

    local status=${PIPESTATUS[0]}

    if [[ ${status} -eq 0 ]]; then
        echo "[DONE] ${short} / ${task} — SUCCESS ($(date))"
        (( TOTAL_RUN++ )) || true
    else
        echo "[FAIL] ${short} / ${task} — exit code ${status} ($(date))"
        (( TOTAL_FAIL++ )) || true
    fi

    return ${status}
}

##############################################################################
# Vision Benchmarks
##############################################################################

run_all() {
    echo ""
    echo "################################################################"
    echo "# Vision Evals — Brick vs qwen3-vl-32b"
    echo "################################################################"

    # 1. MME — Perception generale (14 subtask), ~2374 samples
    echo ""
    echo "=== MME ==="
    for i in "${!SHORT_NAMES[@]}"; do
        run_vision_eval "$i" "mme" "mme" 128
    done

    # 2. MMMU val — Ragionamento multi-disciplina, ~900 samples
    echo ""
    echo "=== MMMU val ==="
    for i in "${!SHORT_NAMES[@]}"; do
        run_vision_eval "$i" "mmmu_val" "mmmu_val" 1024
    done

    # 3. MathVista testmini — Ragionamento visivo-matematico, ~1000 samples
    echo ""
    echo "=== MathVista testmini ==="
    for i in "${!SHORT_NAMES[@]}"; do
        run_vision_eval "$i" "mathvista_testmini" "mathvista_testmini" 1024
    done

    # 4. DocVQA val — Comprensione documenti/OCR, ~5188 samples
    echo ""
    echo "=== DocVQA val ==="
    for i in "${!SHORT_NAMES[@]}"; do
        run_vision_eval "$i" "docvqa_val" "docvqa_val" 256
    done

    # 5. ChartQA — Comprensione grafici, ~2500 samples
    echo ""
    echo "=== ChartQA ==="
    for i in "${!SHORT_NAMES[@]}"; do
        run_vision_eval "$i" "chartqa" "chartqa" 256
    done

    # 6. RealWorldQA — Comprensione visiva real-world, ~765 samples
    echo ""
    echo "=== RealWorldQA ==="
    for i in "${!SHORT_NAMES[@]}"; do
        run_vision_eval "$i" "realworldqa" "realworldqa" 128
    done
}

##############################################################################
# Main
##############################################################################

echo "========================================"
echo " Piano Evals — lmms-eval (vision)"
echo " Date:       ${DATE}"
echo " Dry run:    ${DRY_RUN}"
echo " Only model: ${ONLY_MODEL:-all}"
echo " lmms_eval:  ${LMMS_EVAL}"
echo " Brick URL:  ${BRICK_URL}"
echo " Evals dir:  ${EVALS_DIR}"
echo " Stage3 dir: ${STAGE3_DIR}"
echo "========================================"

run_all

echo ""
echo "========================================"
echo " Vision evaluation campaign complete!"
echo " Run:    ${TOTAL_RUN}"
echo " Skip:   ${TOTAL_SKIP}"
echo " Fail:   ${TOTAL_FAIL}"
echo " Results: ${STAGE3_DIR}/"
echo " Logs:    ${LOGS_DIR}/"
echo "========================================"
