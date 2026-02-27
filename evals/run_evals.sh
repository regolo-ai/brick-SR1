#!/usr/bin/env bash
#
# run_evals.sh — Piano Evals: lm-eval-harness benchmarks for Brick + individual models
#
# Usage:
#   ./run_evals.sh                         # Run all phases
#   ./run_evals.sh --phase 1               # Run only phase 1
#   ./run_evals.sh --dry-run               # Dry run with --limit 5
#   ./run_evals.sh --only brick            # Run only for brick
#   ./run_evals.sh --phase 1 --only brick  # Combine filters
#
# Prerequisites:
#   - lm-eval installed at .venv path below
#   - Brick Docker container running on the eval server
#   - REGOLO_API_KEY env var set
#
set -eo pipefail

##############################################################################
# Configuration
##############################################################################

LM_EVAL="/home/rdseeweb/regolo-semantic-routing/.venv/bin/lm_eval"
EVALS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOGS_DIR="${EVALS_DIR}/logs"
DATE=$(date +%Y-%m-%d)

# Brick gateway (running on dedicated eval server)
BRICK_URL="http://213.171.186.210:8000/v1/chat/completions"

# Regolo API — for individual model baselines
REGOLO_URL="https://api.regolo.ai/v1/chat/completions"

# Parallel arrays: index 0 = brick, 1-8 = individual models
SHORT_NAMES=(brick llama70b gptoss120b gptoss20b mistral32 qwen3coder qwen3_8b gemma27b)
MODELS=(brick Llama-3.3-70B-Instruct gpt-oss-120b gpt-oss-20b mistral-small3.2 qwen3-coder-next Qwen3-8B gemma-3-27b-it)
TOKENIZERS=(
    meta-llama/Llama-3.3-70B-Instruct
    meta-llama/Llama-3.3-70B-Instruct
    Qwen/QwQ-32B
    Qwen/Qwen3-32B
    mistralai/Mistral-Small-3.1-24B-Instruct-2503
    Qwen/Qwen3-235B-A22B
    Qwen/Qwen3-8B
    google/gemma-3-27b-it
)

##############################################################################
# CLI arguments
##############################################################################

PHASE="all"
DRY_RUN=false
ONLY_MODEL=""

while [[ $# -gt 0 ]]; do
    case $1 in
        --phase)   PHASE="$2"; shift 2 ;;
        --dry-run) DRY_RUN=true; shift ;;
        --only)    ONLY_MODEL="$2"; shift 2 ;;
        -h|--help)
            head -16 "${BASH_SOURCE[0]}" | tail -14
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

# lm-eval's openai-chat-completions reads API key from OPENAI_API_KEY env var
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

run_eval() {
    local idx=$1
    local task=$2
    local output_dir=$3
    local max_tokens=$4
    shift 4
    local extra_flags=("$@")

    local short="${SHORT_NAMES[$idx]}"
    local model="${MODELS[$idx]}"
    local tokenizer="${TOKENIZERS[$idx]}"
    local out_dir="${EVALS_DIR}/${output_dir}/${short}"
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

    # Build model type and model_args
    local model_type model_args base_url
    if [[ $idx -eq 0 ]]; then
        base_url="${BRICK_URL}"
    else
        base_url="${REGOLO_URL}"
    fi

    # All models use openai-chat-completions (sends Authorization header)
    model_type="openai-chat-completions"
    model_args="model=${model},base_url=${base_url},tokenizer_backend=huggingface,tokenizer=${tokenizer},stream=false,max_tokens=${max_tokens},temperature=0,top_p=1"

    # Dry run: append --limit 5 (argparse last-value-wins)
    if [[ "${DRY_RUN}" == "true" ]]; then
        extra_flags+=(--limit 5)
    fi

    echo "============================================================"
    echo "[RUN] ${short} / ${task}"
    echo "  Model type: ${model_type}"
    echo "  Model: ${model}"
    echo "  Base URL: ${base_url}"
    echo "  Max tokens: ${max_tokens}"
    echo "  Output: ${out_dir}"
    echo "  Log: ${log_file}"
    echo "  Started: $(date)"
    echo "============================================================"

    # IMPORTANT: Run lm-eval from /tmp to avoid CWD directory names
    # colliding with task names (lm-eval checks Path(task).is_dir()).
    (cd /tmp && "${LM_EVAL}" run \
        --model "${model_type}" \
        --model_args "${model_args}" \
        --tasks "${task}" \
        --output_path "${out_dir}" \
        --log_samples \
        --batch_size 1 \
        --apply_chat_template \
        --trust_remote_code \
        ${extra_flags[@]+"${extra_flags[@]}"} \
    ) 2>&1 | tee "${log_file}"

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
# Phase 1 — Core benchmarks: Brick + all 8 models
##############################################################################

phase1() {
    echo ""
    echo "################################################################"
    echo "# PHASE 1 — Core benchmarks (Brick + 8 individual models)"
    echo "################################################################"

    # 1. MMLU-Pro (5-shot, 500 samples, max_tokens=2048)
    echo ""
    echo "=== MMLU-Pro (5-shot, limit=500) ==="
    for i in "${!SHORT_NAMES[@]}"; do
        run_eval "$i" "mmlu_pro" "mmlu_pro" 2048 \
            --num_fewshot 5 \
            --limit 500 \
            --fewshot_as_multiturn True
    done

    # 2. ARC-Challenge Chat (0-shot built-in, full=1172, max_tokens=100)
    echo ""
    echo "=== ARC-Challenge Chat (0-shot, full) ==="
    for i in "${!SHORT_NAMES[@]}"; do
        run_eval "$i" "arc_challenge_chat" "arc_challenge" 100
    done

    # 3. TruthfulQA Gen (6-shot built-in, full=817, max_tokens=256)
    echo ""
    echo "=== TruthfulQA Gen (6-shot built-in, full) ==="
    for i in "${!SHORT_NAMES[@]}"; do
        run_eval "$i" "truthfulqa_gen" "truthfulqa" 256
    done
}

##############################################################################
# Phase 2 — Extended benchmarks: all models
##############################################################################

phase2() {
    echo ""
    echo "################################################################"
    echo "# PHASE 2 — Extended benchmarks (all models)"
    echo "################################################################"

    # 4. IFEval (0-shot, full=541, max_tokens=1280)
    echo ""
    echo "=== IFEval (0-shot, full) ==="
    for i in "${!SHORT_NAMES[@]}"; do
        run_eval "$i" "ifeval" "ifeval" 1280
    done

    # 5. BBH CoT Zeroshot (0-shot, 50/subtask, max_tokens=2048)
    echo ""
    echo "=== BBH CoT Zeroshot (0-shot, limit=50/subtask) ==="
    for i in "${!SHORT_NAMES[@]}"; do
        run_eval "$i" "bbh_cot_zeroshot" "bbh" 2048 \
            --limit 50
    done

    # 6. DROP (3-shot, 200 samples, max_tokens=2048)
    echo ""
    echo "=== DROP (3-shot, limit=200) ==="
    for i in "${!SHORT_NAMES[@]}"; do
        run_eval "$i" "drop" "drop" 2048 \
            --num_fewshot 3 \
            --limit 200 \
            --fewshot_as_multiturn True
    done

    # 7. Minerva Math (4-shot, 100/subtask, max_tokens=2048)
    echo ""
    echo "=== Minerva Math (4-shot, limit=100/subtask) ==="
    for i in "${!SHORT_NAMES[@]}"; do
        run_eval "$i" "minerva_math" "minerva_math" 2048 \
            --num_fewshot 4 \
            --limit 100 \
            --fewshot_as_multiturn True
    done
}

##############################################################################
# Phase 3 — Code eval (Brick + qwen3-coder + llama70b)
##############################################################################

phase3() {
    echo ""
    echo "################################################################"
    echo "# PHASE 3 — Code eval (Brick + qwen3-coder + llama70b)"
    echo "################################################################"

    export HF_ALLOW_CODE_EVAL=1

    # Code eval models: brick (0), llama70b (1), qwen3coder (5)
    local code_indices=(0 1 5)

    # 8. HumanEval (0-shot, full=164, max_tokens=1024)
    echo ""
    echo "=== HumanEval (0-shot, full) ==="
    for i in "${code_indices[@]}"; do
        run_eval "$i" "humaneval" "humaneval" 1024 \
            --confirm_run_unsafe_code
    done

    # 9. MBPP (3-shot, full=500, max_tokens=512)
    echo ""
    echo "=== MBPP (3-shot, full) ==="
    for i in "${code_indices[@]}"; do
        run_eval "$i" "mbpp" "mbpp" 512 \
            --num_fewshot 3 \
            --fewshot_as_multiturn True \
            --confirm_run_unsafe_code
    done
}

##############################################################################
# Main
##############################################################################

echo "========================================"
echo " Piano Evals — lm-eval-harness"
echo " Date:       ${DATE}"
echo " Phase:      ${PHASE}"
echo " Dry run:    ${DRY_RUN}"
echo " Only model: ${ONLY_MODEL:-all}"
echo " Brick URL:  ${BRICK_URL}"
echo " Evals dir:  ${EVALS_DIR}"
echo "========================================"

case "${PHASE}" in
    1)   phase1 ;;
    2)   phase2 ;;
    3)   phase3 ;;
    all)
        phase1
        phase2
        phase3
        ;;
    *)
        echo "ERROR: Invalid phase '${PHASE}'. Use 1, 2, 3, or all."
        exit 1
        ;;
esac

echo ""
echo "========================================"
echo " Evaluation campaign complete!"
echo " Run:    ${TOTAL_RUN}"
echo " Skip:   ${TOTAL_SKIP}"
echo " Fail:   ${TOTAL_FAIL}"
echo " Results: ${EVALS_DIR}/"
echo " Logs:    ${LOGS_DIR}/"
echo "========================================"
