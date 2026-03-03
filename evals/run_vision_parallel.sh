#!/usr/bin/env bash
#
# run_vision_parallel.sh — Parallel vision eval launcher using tmux (1 session per model)
#
# Usage:
#   ./run_vision_parallel.sh             # Launch 2 models in parallel tmux sessions
#   ./run_vision_parallel.sh --dry-run   # Same but with --limit 2 on every benchmark
#
# Prerequisites:
#   - tmux installed
#   - lmms-eval installed in .venv-vision
#   - REGOLO_API_KEY env var set
#   - Brick Docker container running on the eval server
#
# Monitoring:
#   ./check_vision_status.sh             # Check progress of all sessions
#   tmux attach -t vision-brick          # Attach to a specific session
#   tmux ls                              # List all sessions
#
set -eo pipefail

##############################################################################
# Configuration
##############################################################################

EVALS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STAGE3_DIR="${EVALS_DIR}/stage3"
DATE=$(date +%Y-%m-%d_%H%M)

# Auto-detect lmms_eval
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

# Brick gateway — no /chat/completions suffix (OpenAI client adds it)
BRICK_URL="http://213.171.186.210:8000/v1"

# Regolo API — for qwen3-vl-32b baseline
REGOLO_URL="https://api.regolo.ai/v1"

# Parallel arrays: index 0 = brick, 1 = qwen3-vl-32b
SHORT_NAMES=(brick qwen3vl32b)
MODELS=(brick qwen3-vl-32b)

# All vision benchmarks (task, output_subdir, max_tokens)
ALL_BENCHMARKS="mme mmmu_val mathvista_testmini docvqa_val chartqa realworldqa"

##############################################################################
# CLI arguments
##############################################################################

DRY_RUN=false

while [[ $# -gt 0 ]]; do
    case $1 in
        --dry-run) DRY_RUN=true; shift ;;
        -h|--help)
            head -20 "${BASH_SOURCE[0]}" | tail -18
            exit 0
            ;;
        *) echo "Unknown option: $1"; exit 1 ;;
    esac
done

##############################################################################
# Checks
##############################################################################

if [[ -z "${REGOLO_API_KEY:-}" ]]; then
    echo "ERROR: REGOLO_API_KEY is not set."
    echo "Export it before running: export REGOLO_API_KEY=sk-..."
    exit 1
fi

if ! command -v tmux &>/dev/null; then
    echo "ERROR: tmux is not installed."
    exit 1
fi

##############################################################################
# Create stage3/ structure
##############################################################################

echo "==> Creating stage3/ directory structure ..."

BENCHMARK_DIRS=(mme mmmu_val mathvista_testmini docvqa_val chartqa realworldqa)

for bench in "${BENCHMARK_DIRS[@]}"; do
    for short in "${SHORT_NAMES[@]}"; do
        mkdir -p "${STAGE3_DIR}/${bench}/${short}"
    done
done

mkdir -p "${STAGE3_DIR}/logs"
echo "    Done."

##############################################################################
# Helper: generate lmms_eval command for a benchmark
##############################################################################

# Arguments: short, model, base_url, task, output_subdir, max_tokens
gen_benchmark_cmd() {
    local short="$1"
    local model="$2"
    local base_url="$3"
    local task="$4"
    local output_subdir="$5"
    local max_tokens="$6"

    local out_dir="${STAGE3_DIR}/${output_subdir}/${short}"

    # Build dry-run limit flag
    local limit_flag=""
    if [[ "${DRY_RUN}" == "true" ]]; then
        limit_flag="--limit 2"
    fi

    cat <<BENCH_EOF

# --- ${output_subdir} ---
echo ""
echo "============================================================"
echo "[RUN] ${short} / ${task}"
echo "  Started: \$(date)"
echo "============================================================"
if find "${out_dir}" -name "results*.json" -print -quit 2>/dev/null | grep -q .; then
    echo "[SKIP] ${short} / ${task} — results already exist"
    SKIPPED=\$((SKIPPED + 1))
else
    (cd /tmp && "${LMMS_EVAL}" eval \\
        --model openai \\
        --model_args "model_version=${model},base_url=${base_url},timeout=120,max_retries=10" \\
        --tasks "${task}" \\
        --max_tokens ${max_tokens} \\
        --output_path "${out_dir}" \\
        --log_samples \\
        --batch_size 1 \\
        ${limit_flag} \\
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

##############################################################################
# Generate per-model scripts and launch tmux sessions
##############################################################################

echo "==> Launching tmux sessions ..."
echo ""

LAUNCHED=0

for idx in "${!SHORT_NAMES[@]}"; do
    short="${SHORT_NAMES[$idx]}"
    model="${MODELS[$idx]}"

    if [[ $idx -eq 0 ]]; then
        base_url="${BRICK_URL}"
    else
        base_url="${REGOLO_URL}"
    fi

    session_name="vision-${short}"
    log_file="${STAGE3_DIR}/logs/${short}_all_${DATE}.log"
    tmp_script="/tmp/vision_eval_${short}.sh"

    # Check if session already exists
    if tmux has-session -t "${session_name}" 2>/dev/null; then
        echo "  [SKIP] Session '${session_name}' already exists — skipping"
        continue
    fi

    # Generate the per-model script
    cat > "${tmp_script}" <<SCRIPT_HEADER
#!/usr/bin/env bash
# Auto-generated vision eval script for ${short}
# Generated: $(date)
set +e  # Don't exit on error — we handle failures per-benchmark

export OPENAI_API_KEY="${REGOLO_API_KEY}"

PASSED=0
FAILED=0
SKIPPED=0

echo "========================================"
echo " Vision eval session: ${short}"
echo " Model: ${model}"
echo " Started: \$(date)"
echo "========================================"
SCRIPT_HEADER

    # 1. MME (max_tokens=128)
    gen_benchmark_cmd "${short}" "${model}" "${base_url}" \
        "mme" "mme" 128 >> "${tmp_script}"

    # 2. MMMU val (max_tokens=1024)
    gen_benchmark_cmd "${short}" "${model}" "${base_url}" \
        "mmmu_val" "mmmu_val" 1024 >> "${tmp_script}"

    # 3. MathVista testmini (max_tokens=1024)
    gen_benchmark_cmd "${short}" "${model}" "${base_url}" \
        "mathvista_testmini" "mathvista_testmini" 1024 >> "${tmp_script}"

    # 4. DocVQA val (max_tokens=256)
    gen_benchmark_cmd "${short}" "${model}" "${base_url}" \
        "docvqa_val" "docvqa_val" 256 >> "${tmp_script}"

    # 5. ChartQA (max_tokens=256)
    gen_benchmark_cmd "${short}" "${model}" "${base_url}" \
        "chartqa" "chartqa" 256 >> "${tmp_script}"

    # 6. RealWorldQA (max_tokens=128)
    gen_benchmark_cmd "${short}" "${model}" "${base_url}" \
        "realworldqa" "realworldqa" 128 >> "${tmp_script}"

    # Summary and keep session alive
    cat >> "${tmp_script}" <<SCRIPT_FOOTER

echo ""
echo "========================================"
echo " Vision eval session complete: ${short}"
echo " Passed:  \${PASSED}"
echo " Failed:  \${FAILED}"
echo " Skipped: \${SKIPPED}"
echo " Total:   6"
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
    echo "  [OK] ${session_name}  →  6 vision benchmarks  |  log: ${log_file}"
done

echo ""

##############################################################################
# Summary
##############################################################################

echo "========================================"
echo " Vision Parallel Eval Launcher"
echo " Date:        $(date)"
echo " Dry run:     ${DRY_RUN}"
echo " Sessions:    ${LAUNCHED} launched"
echo " Results dir: ${STAGE3_DIR}/"
echo " Logs dir:    ${STAGE3_DIR}/logs/"
echo "========================================"
echo ""
echo "  Monitor progress:"
echo "    ./check_vision_status.sh"
echo ""
echo "  Attach to a session:"
echo "    tmux attach -t vision-brick"
echo ""
echo "  List all sessions:"
echo "    tmux ls"
echo ""
