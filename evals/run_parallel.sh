#!/usr/bin/env bash
#
# run_parallel.sh — Parallel eval launcher using tmux (1 session per model)
#
# Usage:
#   ./run_parallel.sh             # Launch all 7 models in parallel tmux sessions
#   ./run_parallel.sh --dry-run   # Same but with --limit 5 on every benchmark
#
# Prerequisites:
#   - tmux installed
#   - lm-eval installed (auto-detected from .venv)
#   - REGOLO_API_KEY env var set
#   - Brick Docker container running on the eval server
#
# Monitoring:
#   ./check_status.sh             # Check progress of all sessions
#   tmux attach -t eval-brick     # Attach to a specific session
#   tmux ls                       # List all sessions
#
set -eo pipefail

##############################################################################
# Configuration
##############################################################################

EVALS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DATE=$(date +%Y-%m-%d_%H%M)

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
    echo "ERROR: lm_eval not found. Install it or activate the venv."
    exit 1
fi

# Brick gateway (running on dedicated eval server)
BRICK_URL="http://213.171.186.210:8000/v1/chat/completions"

# Regolo API — for individual model baselines
REGOLO_URL="https://api.regolo.ai/v1/chat/completions"

# Parallel arrays: index 0 = brick, 1-6 = individual models
SHORT_NAMES=(brick llama70b gptoss120b gptoss20b mistral32 qwen3coder qwen3_8b)
MODELS=(brick Llama-3.3-70B-Instruct gpt-oss-120b gpt-oss-20b mistral-small3.2 qwen3-coder-next Qwen3-8B)
TOKENIZERS=(
    meta-llama/Llama-3.3-70B-Instruct
    meta-llama/Llama-3.3-70B-Instruct
    Qwen/QwQ-32B
    Qwen/Qwen3-32B
    mistralai/Mistral-Small-3.1-24B-Instruct-2503
    Qwen/Qwen3-235B-A22B
    Qwen/Qwen3-8B
)

# Models that run code eval benchmarks (humaneval, mbpp)
CODE_EVAL_SHORTS="brick llama70b qwen3coder"

# All benchmarks (in order)
ALL_BENCHMARKS="mmlu_pro arc_challenge truthfulqa ifeval bbh drop minerva_math humaneval mbpp"

# Stage directories
STAGE1_DIR="${EVALS_DIR}/stage1"
STAGE2_DIR="${EVALS_DIR}/stage2"

##############################################################################
# CLI arguments
##############################################################################

DRY_RUN=false

while [[ $# -gt 0 ]]; do
    case $1 in
        --dry-run) DRY_RUN=true; shift ;;
        -h|--help)
            head -18 "${BASH_SOURCE[0]}" | tail -16
            exit 0
            ;;
        *) echo "Unknown option: $1"; exit 1 ;;
    esac
done

##############################################################################
# Checks
##############################################################################

if [[ -z "${REGOLO_API_KEY:-}" ]]; then
    REGOLO_API_KEY="sk-NklmaM1W15f-FWYh8Li-mA"
    echo "==> REGOLO_API_KEY not set, using built-in default."
fi

if ! command -v tmux &>/dev/null; then
    echo "ERROR: tmux is not installed."
    exit 1
fi

##############################################################################
# Step 1: Migrate existing results to stage1/ (idempotent)
##############################################################################

if [[ ! -d "${STAGE1_DIR}" ]]; then
    echo "==> Migrating existing results to stage1/ ..."

    # Only migrate if there's something to move
    HAS_RESULTS=false
    if [[ -d "${EVALS_DIR}/mmlu_pro" ]] && find "${EVALS_DIR}/mmlu_pro" -name "results*.json" -print -quit 2>/dev/null | grep -q .; then
        HAS_RESULTS=true
    fi
    if [[ -d "${EVALS_DIR}/logs" ]] && ls "${EVALS_DIR}/logs/"*.log &>/dev/null; then
        HAS_RESULTS=true
    fi

    if [[ "${HAS_RESULTS}" == "true" ]]; then
        mkdir -p "${STAGE1_DIR}"

        # Move mmlu_pro results (has actual data)
        if [[ -d "${EVALS_DIR}/mmlu_pro" ]]; then
            mv "${EVALS_DIR}/mmlu_pro" "${STAGE1_DIR}/mmlu_pro"
            echo "    Moved mmlu_pro/ -> stage1/mmlu_pro/"
        fi

        # Move logs
        if [[ -d "${EVALS_DIR}/logs" ]]; then
            mv "${EVALS_DIR}/logs" "${STAGE1_DIR}/logs"
            echo "    Moved logs/ -> stage1/logs/"
        fi

        echo "    Migration complete."
    else
        echo "    No existing results to migrate."
    fi

    # Remove empty benchmark directories
    for dir in arc_challenge bbh drop humaneval ifeval mbpp minerva_math truthfulqa; do
        if [[ -d "${EVALS_DIR}/${dir}" ]] && [[ -z "$(ls -A "${EVALS_DIR}/${dir}")" ]]; then
            rmdir "${EVALS_DIR}/${dir}"
            echo "    Removed empty dir: ${dir}/"
        fi
    done
else
    echo "==> stage1/ already exists, skipping migration."
fi

##############################################################################
# Step 2: Create stage2/ structure
##############################################################################

echo "==> Creating stage2/ directory structure ..."

BENCHMARK_DIRS=(mmlu_pro arc_challenge truthfulqa ifeval bbh drop minerva_math)
CODE_BENCHMARK_DIRS=(humaneval mbpp)

for bench in "${BENCHMARK_DIRS[@]}"; do
    for short in "${SHORT_NAMES[@]}"; do
        mkdir -p "${STAGE2_DIR}/${bench}/${short}"
    done
done

# Code eval benchmarks: only for brick, llama70b, qwen3coder
for bench in "${CODE_BENCHMARK_DIRS[@]}"; do
    for short in ${CODE_EVAL_SHORTS}; do
        mkdir -p "${STAGE2_DIR}/${bench}/${short}"
    done
done

mkdir -p "${STAGE2_DIR}/logs"
echo "    Done."

##############################################################################
# Step 3: Generate per-model scripts and launch tmux sessions
##############################################################################

echo "==> Launching tmux sessions ..."
echo ""

# Helper: generate the lm_eval command for a benchmark
# Arguments: short, model, tokenizer, base_url, task, output_subdir, max_tokens, extra_flags...
gen_benchmark_cmd() {
    local short="$1"
    local model="$2"
    local tokenizer="$3"
    local base_url="$4"
    local task="$5"
    local output_subdir="$6"
    local max_tokens="$7"
    shift 7
    local extra_flags="$*"

    local out_dir="${STAGE2_DIR}/${output_subdir}/${short}"
    local bench_label="${output_subdir}"

    cat <<BENCH_EOF

# --- ${bench_label} ---
echo ""
echo "============================================================"
echo "[RUN] ${short} / ${task}"
echo "  Started: \$(date)"
echo "============================================================"
if find "${out_dir}" -name "results*.json" -print -quit 2>/dev/null | grep -q .; then
    echo "[SKIP] ${short} / ${task} — results already exist"
    SKIPPED=\$((SKIPPED + 1))
else
    (cd /tmp && "${LM_EVAL}" run \\
        --model openai-chat-completions \\
        --model_args "model=${model},base_url=${base_url},tokenizer_backend=huggingface,tokenizer=${tokenizer},stream=false,max_tokens=${max_tokens},temperature=0,top_p=1" \\
        --tasks "${task}" \\
        --output_path "${out_dir}" \\
        --log_samples \\
        --batch_size 1 \\
        --apply_chat_template \\
        --trust_remote_code \\
        ${extra_flags} \\
    ) && {
        echo "[DONE] ${short} / ${task} — SUCCESS (\$(date))"
        PASSED=\$((PASSED + 1))
    } || {
        echo "[FAIL] ${short} / ${task} — exit code \$? (\$(date))"
        FAILED=\$((FAILED + 1))
    }
fi
BENCH_EOF
}

# Build dry-run limit flag
DRY_RUN_FLAG=""
if [[ "${DRY_RUN}" == "true" ]]; then
    DRY_RUN_FLAG="--limit 5"
fi

LAUNCHED=0

for idx in "${!SHORT_NAMES[@]}"; do
    short="${SHORT_NAMES[$idx]}"
    model="${MODELS[$idx]}"
    tokenizer="${TOKENIZERS[$idx]}"

    if [[ $idx -eq 0 ]]; then
        base_url="${BRICK_URL}"
    else
        base_url="${REGOLO_URL}"
    fi

    session_name="eval-${short}"
    log_file="${STAGE2_DIR}/logs/${short}_all_${DATE}.log"
    tmp_script="/tmp/eval_${short}.sh"

    # Check if session already exists
    if tmux has-session -t "${session_name}" 2>/dev/null; then
        echo "  [SKIP] Session '${session_name}' already exists — skipping"
        continue
    fi

    # Determine which benchmarks this model runs
    is_code_model=false
    for cm in ${CODE_EVAL_SHORTS}; do
        if [[ "${short}" == "${cm}" ]]; then
            is_code_model=true
            break
        fi
    done

    # Generate the per-model script
    cat > "${tmp_script}" <<SCRIPT_HEADER
#!/usr/bin/env bash
# Auto-generated eval script for ${short}
# Generated: $(date)
set +e  # Don't exit on error — we handle failures per-benchmark

export OPENAI_API_KEY="${REGOLO_API_KEY}"
export HF_ALLOW_CODE_EVAL=1

PASSED=0
FAILED=0
SKIPPED=0

echo "========================================"
echo " Eval session: ${short}"
echo " Model: ${model}"
echo " Started: \$(date)"
echo "========================================"
SCRIPT_HEADER

    # 1. MMLU-Pro (5-shot, 500 samples)
    gen_benchmark_cmd "${short}" "${model}" "${tokenizer}" "${base_url}" \
        "mmlu_pro" "mmlu_pro" 2048 \
        "--num_fewshot 5 --limit 500 --fewshot_as_multiturn True ${DRY_RUN_FLAG}" \
        >> "${tmp_script}"

    # 2. ARC-Challenge (0-shot, full)
    gen_benchmark_cmd "${short}" "${model}" "${tokenizer}" "${base_url}" \
        "arc_challenge_chat" "arc_challenge" 100 \
        "${DRY_RUN_FLAG}" \
        >> "${tmp_script}"

    # 3. TruthfulQA (0-shot, full)
    gen_benchmark_cmd "${short}" "${model}" "${tokenizer}" "${base_url}" \
        "truthfulqa_gen" "truthfulqa" 256 \
        "${DRY_RUN_FLAG}" \
        >> "${tmp_script}"

    # 4. IFEval (0-shot, full)
    gen_benchmark_cmd "${short}" "${model}" "${tokenizer}" "${base_url}" \
        "ifeval" "ifeval" 1280 \
        "${DRY_RUN_FLAG}" \
        >> "${tmp_script}"

    # 5. BBH CoT (0-shot, limit 50)
    gen_benchmark_cmd "${short}" "${model}" "${tokenizer}" "${base_url}" \
        "bbh_cot_zeroshot" "bbh" 2048 \
        "--limit 50 ${DRY_RUN_FLAG}" \
        >> "${tmp_script}"

    # 6. DROP (3-shot, limit 200)
    gen_benchmark_cmd "${short}" "${model}" "${tokenizer}" "${base_url}" \
        "drop" "drop" 2048 \
        "--num_fewshot 3 --limit 200 --fewshot_as_multiturn True ${DRY_RUN_FLAG}" \
        >> "${tmp_script}"

    # 7. Minerva Math (4-shot, limit 100)
    gen_benchmark_cmd "${short}" "${model}" "${tokenizer}" "${base_url}" \
        "minerva_math" "minerva_math" 2048 \
        "--num_fewshot 4 --limit 100 --fewshot_as_multiturn True ${DRY_RUN_FLAG}" \
        >> "${tmp_script}"

    # 8-9. Code eval (only for code models)
    if [[ "${is_code_model}" == "true" ]]; then
        # 8. HumanEval (0-shot, full)
        gen_benchmark_cmd "${short}" "${model}" "${tokenizer}" "${base_url}" \
            "humaneval" "humaneval" 1024 \
            "--confirm_run_unsafe_code ${DRY_RUN_FLAG}" \
            >> "${tmp_script}"

        # 9. MBPP (3-shot, full)
        gen_benchmark_cmd "${short}" "${model}" "${tokenizer}" "${base_url}" \
            "mbpp" "mbpp" 512 \
            "--num_fewshot 3 --fewshot_as_multiturn True --confirm_run_unsafe_code ${DRY_RUN_FLAG}" \
            >> "${tmp_script}"
    fi

    # Summary and keep session alive
    if [[ "${is_code_model}" == "true" ]]; then
        total_benchmarks=9
    else
        total_benchmarks=7
    fi

    cat >> "${tmp_script}" <<SCRIPT_FOOTER

echo ""
echo "========================================"
echo " Eval session complete: ${short}"
echo " Passed:  \${PASSED}"
echo " Failed:  \${FAILED}"
echo " Skipped: \${SKIPPED}"
echo " Total:   ${total_benchmarks}"
echo " Finished: \$(date)"
echo "========================================"

# Keep session alive for inspection
exec bash
SCRIPT_FOOTER

    chmod +x "${tmp_script}"

    # Launch tmux session
    tmux new-session -d -s "${session_name}" \
        "bash ${tmp_script} 2>&1 | tee ${log_file}"

    LAUNCHED=$((LAUNCHED + 1))

    if [[ "${is_code_model}" == "true" ]]; then
        bench_count="9 benchmarks (incl. code eval)"
    else
        bench_count="7 benchmarks"
    fi
    echo "  [OK] ${session_name}  →  ${bench_count}  |  log: ${log_file}"
done

echo ""

##############################################################################
# Step 4: Summary table
##############################################################################

echo "========================================"
echo " Parallel Eval Launcher"
echo " Date:        $(date)"
echo " Dry run:     ${DRY_RUN}"
echo " Sessions:    ${LAUNCHED} launched"
echo " Results dir: ${STAGE2_DIR}/"
echo " Logs dir:    ${STAGE2_DIR}/logs/"
echo "========================================"
echo ""
echo "  Monitor progress:"
echo "    ./check_status.sh"
echo ""
echo "  Attach to a session:"
echo "    tmux attach -t eval-brick"
echo ""
echo "  List all sessions:"
echo "    tmux ls"
echo ""
