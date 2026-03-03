#!/usr/bin/env bash
#
# run_retry.sh — Re-run only the failed/broken benchmarks from the 27/02 eval run
#
# What this fixes:
#   P2. 503 errors  — re-runs mmlu_pro, truthfulqa for llama70b/mistral32/qwen3_8b
#   P3. ARC-Challenge — overrides broken stop sequences (until=["\n\n","."]) for ALL models
#   P4. DROP — overrides broken stop sequences (until=["."]) for ALL models
#   P5. HumanEval — uses humaneval_instruct instead of humaneval for code models
#
# Usage:
#   ./run_retry.sh             # Run all retries
#   ./run_retry.sh --dry-run   # Same but with --limit 5 on every benchmark
#
# Prerequisites:
#   - tmux installed
#   - lm-eval installed (auto-detected from .venv)
#   - REGOLO_API_KEY env var set
#   - Brick Docker container running on the eval server
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

STAGE2_DIR="${EVALS_DIR}/stage2"

##############################################################################
# Per-model retry configuration
#
# Each model lists only the benchmarks that need re-running.
# Format: "benchmark_key" where benchmark_key maps to a specific task+flags.
##############################################################################

declare -A RETRY_BENCHMARKS
RETRY_BENCHMARKS[brick]="arc_challenge drop humaneval"
RETRY_BENCHMARKS[llama70b]="mmlu_pro truthfulqa arc_challenge drop humaneval"
RETRY_BENCHMARKS[gptoss120b]="arc_challenge drop"
RETRY_BENCHMARKS[gptoss20b]="arc_challenge drop"
RETRY_BENCHMARKS[mistral32]="mmlu_pro truthfulqa arc_challenge drop"
RETRY_BENCHMARKS[qwen3coder]="arc_challenge drop"
RETRY_BENCHMARKS[qwen3_8b]="mmlu_pro truthfulqa arc_challenge drop"

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

if [[ ! -d "${STAGE2_DIR}" ]]; then
    echo "ERROR: ${STAGE2_DIR} does not exist. Run run_parallel.sh first."
    exit 1
fi

##############################################################################
# Step 1: Delete broken results for benchmarks we're re-running
##############################################################################

echo "==> Cleaning broken results ..."

for idx in "${!SHORT_NAMES[@]}"; do
    short="${SHORT_NAMES[$idx]}"
    benchmarks="${RETRY_BENCHMARKS[$short]:-}"
    [[ -z "${benchmarks}" ]] && continue

    for bench_key in ${benchmarks}; do
        result_dir="${STAGE2_DIR}/${bench_key}/${short}"
        if [[ -d "${result_dir}" ]]; then
            # Delete all contents but keep the directory
            rm -rf "${result_dir:?}"/*
            echo "    Cleaned: ${result_dir}/"
        fi
    done
done

echo "    Done."

##############################################################################
# Step 2: Kill old eval-* tmux sessions
##############################################################################

echo ""
echo "==> Cleaning old eval tmux sessions ..."

for short in "${SHORT_NAMES[@]}"; do
    session_name="eval-${short}"
    if tmux has-session -t "${session_name}" 2>/dev/null; then
        tmux kill-session -t "${session_name}"
        echo "    Killed: ${session_name}"
    fi
done

echo "    Done."

##############################################################################
# Step 3: Generate per-model retry scripts and launch tmux sessions
##############################################################################

echo ""
echo "==> Launching retry tmux sessions ..."
echo ""

# Build dry-run limit flag
DRY_RUN_FLAG=""
if [[ "${DRY_RUN}" == "true" ]]; then
    DRY_RUN_FLAG="--limit 5"
fi

# Helper: generate a single benchmark command block
# Arguments: short model tokenizer base_url task output_subdir max_tokens extra_flags...
gen_retry_cmd() {
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

    cat <<BENCH_EOF

# --- ${output_subdir} (${task}) ---
echo ""
echo "============================================================"
echo "[RETRY] ${short} / ${task}"
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

LAUNCHED=0

for idx in "${!SHORT_NAMES[@]}"; do
    short="${SHORT_NAMES[$idx]}"
    model="${MODELS[$idx]}"
    tokenizer="${TOKENIZERS[$idx]}"
    benchmarks="${RETRY_BENCHMARKS[$short]:-}"

    # Skip models with no retries needed
    [[ -z "${benchmarks}" ]] && continue

    if [[ $idx -eq 0 ]]; then
        base_url="${BRICK_URL}"
    else
        base_url="${REGOLO_URL}"
    fi

    session_name="eval-${short}"
    log_file="${STAGE2_DIR}/logs/${short}_retry_${DATE}.log"
    tmp_script="/tmp/eval_retry_${short}.sh"

    # Count benchmarks for this model
    bench_count=0
    for _ in ${benchmarks}; do
        bench_count=$((bench_count + 1))
    done

    # Generate the per-model retry script
    cat > "${tmp_script}" <<SCRIPT_HEADER
#!/usr/bin/env bash
# Auto-generated RETRY script for ${short}
# Generated: $(date)
# Benchmarks to retry: ${benchmarks}
set +e  # Don't exit on error — we handle failures per-benchmark

export OPENAI_API_KEY="${REGOLO_API_KEY}"
export HF_ALLOW_CODE_EVAL=1

PASSED=0
FAILED=0
SKIPPED=0

echo "========================================"
echo " RETRY session: ${short}"
echo " Model: ${model}"
echo " Benchmarks: ${benchmarks}"
echo " Started: \$(date)"
echo "========================================"
SCRIPT_HEADER

    # Generate commands for each benchmark this model needs to retry
    for bench_key in ${benchmarks}; do
        case "${bench_key}" in
            mmlu_pro)
                gen_retry_cmd "${short}" "${model}" "${tokenizer}" "${base_url}" \
                    "mmlu_pro" "mmlu_pro" 2048 \
                    "--num_fewshot 5 --limit 500 --fewshot_as_multiturn True ${DRY_RUN_FLAG}" \
                    >> "${tmp_script}"
                ;;
            truthfulqa)
                gen_retry_cmd "${short}" "${model}" "${tokenizer}" "${base_url}" \
                    "truthfulqa_gen" "truthfulqa" 256 \
                    "${DRY_RUN_FLAG}" \
                    >> "${tmp_script}"
                ;;
            arc_challenge)
                # P3 FIX: Override stop sequences — original until=["\n\n","."] truncates answers
                gen_retry_cmd "${short}" "${model}" "${tokenizer}" "${base_url}" \
                    "arc_challenge_chat" "arc_challenge" 256 \
                    "--gen_kwargs '{\"until\":[\"\\n\\nQuestion:\"],\"max_gen_toks\":256}' ${DRY_RUN_FLAG}" \
                    >> "${tmp_script}"
                ;;
            drop)
                # P4 FIX: Override stop sequences — original until=["."] truncates answers
                gen_retry_cmd "${short}" "${model}" "${tokenizer}" "${base_url}" \
                    "drop" "drop" 2048 \
                    "--num_fewshot 3 --limit 200 --fewshot_as_multiturn True --gen_kwargs '{\"until\":[\"\\n\\n\"]}' ${DRY_RUN_FLAG}" \
                    >> "${tmp_script}"
                ;;
            humaneval)
                # P5 FIX: Use humaneval_instruct instead of humaneval for chat models
                gen_retry_cmd "${short}" "${model}" "${tokenizer}" "${base_url}" \
                    "humaneval_instruct" "humaneval" 1024 \
                    "--confirm_run_unsafe_code ${DRY_RUN_FLAG}" \
                    >> "${tmp_script}"
                ;;
        esac
    done

    # Summary footer
    cat >> "${tmp_script}" <<SCRIPT_FOOTER

echo ""
echo "========================================"
echo " RETRY session complete: ${short}"
echo " Passed:  \${PASSED}"
echo " Failed:  \${FAILED}"
echo " Skipped: \${SKIPPED}"
echo " Total:   ${bench_count}"
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
    echo "  [OK] ${session_name}  →  ${bench_count} retries  |  log: ${log_file}"
done

echo ""

##############################################################################
# Step 4: Summary
##############################################################################

echo "========================================"
echo " Retry Eval Launcher"
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
