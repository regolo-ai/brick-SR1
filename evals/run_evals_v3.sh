#!/usr/bin/env bash
#
# run_evals_v3.sh — Piano Evals v3: Brick-only benchmarks with Docker log tagging
#
# Same structure as v2 — Brick-only, sequential, system prompts, monkey-patch.
# NEW: 25% limits, Docker log capture per-benchmark, stage6/ output.
#
# Usage:
#   ./run_evals_v3.sh                  # Launch tmux session with all benchmarks
#   ./run_evals_v3.sh --phase 1        # Run only phase 1
#   ./run_evals_v3.sh --dry-run        # Dry run with --limit 5
#   ./run_evals_v3.sh --no-tmux        # Run in foreground (no tmux)
#
# Monitor:
#   tmux attach -t evals-v3
#
# Prerequisites:
#   - lm-eval installed at .venv path below
#   - Brick Docker container running on the eval server
#   - REGOLO_API_KEY env var set
#   - Docker access for log capture (docker logs)
#
set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT_PATH="${SCRIPT_DIR}/$(basename "${BASH_SOURCE[0]}")"

##############################################################################
# tmux launcher — re-exec inside a tmux session unless --no-tmux or already in
##############################################################################

USE_TMUX=true
for arg in "$@"; do
    [[ "$arg" == "--no-tmux" ]] && USE_TMUX=false
done

TMUX_SESSION="evals-v3"

if [[ "${USE_TMUX}" == "true" && -z "${TMUX:-}" && -z "${INSIDE_EVALS_TMUX:-}" ]]; then
    # Pre-flight check before launching tmux
    if [[ -z "${REGOLO_API_KEY:-}" ]]; then
        echo "ERROR: REGOLO_API_KEY is not set."
        echo "Export it before running: export REGOLO_API_KEY=sk-..."
        exit 1
    fi

    # Kill existing session if present
    tmux kill-session -t "${TMUX_SESSION}" 2>/dev/null || true

    # Build args without --no-tmux
    ARGS=()
    for arg in "$@"; do
        [[ "$arg" != "--no-tmux" ]] && ARGS+=("$arg")
    done

    echo "Launching tmux session '${TMUX_SESSION}'..."
    echo "  Attach with:  tmux attach -t ${TMUX_SESSION}"
    echo "  Kill with:    tmux kill-session -t ${TMUX_SESSION}"

    tmux new-session -d -s "${TMUX_SESSION}" \
        "INSIDE_EVALS_TMUX=1 REGOLO_API_KEY='${REGOLO_API_KEY}' bash '${SCRIPT_PATH}' --no-tmux ${ARGS[*]+"${ARGS[*]}"}"
    exit 0
fi

##############################################################################
# Configuration
##############################################################################

LM_EVAL="/root/forkGO/semantic-routing/.venv/bin/lm_eval"
EVALS_DIR="${SCRIPT_DIR}"
STAGE_DIR="${EVALS_DIR}/stage6"
LOGS_DIR="${STAGE_DIR}/logs"
DOCKER_LOGS_DIR="${STAGE_DIR}/docker_logs"
DATE=$(date +%Y-%m-%d)

# Brick gateway (running on dedicated eval server)
BRICK_URL="http://213.171.186.210:8000/v1/chat/completions"

# Brick only — single model
MODEL="brick"
TOKENIZER="Qwen/Qwen2.5-72B-Instruct"

# Docker container name for log capture
# Override with DOCKER_CONTAINER env var if needed
DOCKER_CONTAINER="${DOCKER_CONTAINER:-docker-compose-mymodel-1}"

##############################################################################
# CLI arguments
##############################################################################

PHASE="all"
DRY_RUN=false

while [[ $# -gt 0 ]]; do
    case $1 in
        --phase)    PHASE="$2"; shift 2 ;;
        --dry-run)  DRY_RUN=true; shift ;;
        --no-tmux)  shift ;;  # already handled above
        -h|--help)
            head -22 "${BASH_SOURCE[0]}" | tail -20
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

mkdir -p "${LOGS_DIR}" "${DOCKER_LOGS_DIR}"

# Token usage sidecar — saved alongside results for cost analysis
export USAGE_LOG_PATH="${STAGE_DIR}/brick_usage.jsonl"

##############################################################################
# Counters
##############################################################################

TOTAL_RUN=0
TOTAL_SKIP=0
TOTAL_FAIL=0

##############################################################################
# System instruction selection
##############################################################################

get_system_instruction() {
    local task=$1
    case "${task}" in
        arc_challenge*|mmlu_pro*|brick_general*)
            echo "For multiple choice questions, end your response with \"the answer is (X)\" where X is the letter."
            ;;
        bbh_cot_zeroshot*)
            echo "End your response with the final answer on its own line."
            ;;
        minerva_math*)
            echo "Put your final numerical answer in \\boxed{}."
            ;;
        drop*)
            echo "Answer the question with a short, direct response."
            ;;
        humaneval*|mbpp*)
            echo "Provide only the implementation code, no explanations or markdown."
            ;;
        ifeval*)
            echo "Follow the formatting instructions precisely."
            ;;
        truthfulqa*)
            echo "Answer concisely."
            ;;
        *)
            echo ""
            ;;
    esac
}

##############################################################################
# Docker log capture helpers
##############################################################################

capture_docker_logs() {
    local task_name=$1
    local ts_before=$2

    local raw_log="${DOCKER_LOGS_DIR}/${task_name}.log"
    local jsonl_log="${DOCKER_LOGS_DIR}/${task_name}.jsonl"

    echo "[LOG] Capturing Docker logs for ${task_name} since ${ts_before}..."

    # Capture raw docker logs since the timestamp
    if docker logs --since "${ts_before}" "${DOCKER_CONTAINER}" > "${raw_log}" 2>&1; then
        echo "[LOG] Raw logs saved to ${raw_log} ($(wc -l < "${raw_log}") lines)"
    else
        echo "[WARN] Failed to capture Docker logs for ${task_name} — container '${DOCKER_CONTAINER}' may not be accessible"
        return 0
    fi

    # Parse raw logs to JSONL with benchmark tag
    python3 -c "
import json, sys

benchmark = '${task_name}'
infile = '${raw_log}'
outfile = '${jsonl_log}'

count = 0
with open(infile, 'r', errors='replace') as f_in, open(outfile, 'w') as f_out:
    for line in f_in:
        line = line.strip()
        if not line:
            continue
        # Try to parse as JSON (structured log line)
        try:
            obj = json.loads(line)
            obj['benchmark'] = benchmark
            f_out.write(json.dumps(obj) + '\n')
            count += 1
        except json.JSONDecodeError:
            # Wrap non-JSON log lines
            obj = {'raw': line, 'benchmark': benchmark}
            f_out.write(json.dumps(obj) + '\n')
            count += 1

print(f'[LOG] JSONL tagged: {count} lines -> {outfile}')
" || echo "[WARN] JSONL parsing failed for ${task_name}"
}

combine_docker_logs() {
    local combined="${DOCKER_LOGS_DIR}/all_benchmarks_combined.jsonl"
    echo "[LOG] Combining all JSONL docker logs..."
    cat "${DOCKER_LOGS_DIR}"/*.jsonl > "${combined}" 2>/dev/null || true
    if [[ -f "${combined}" ]]; then
        echo "[LOG] Combined log: ${combined} ($(wc -l < "${combined}") lines)"
    fi
}

##############################################################################
# Core function — runs a single benchmark for Brick with Docker log capture
##############################################################################

run_eval() {
    local task=$1
    local output_dir=$2
    local max_tokens=$3
    shift 3
    local extra_flags=("$@")

    local out_dir="${STAGE_DIR}/${output_dir}/brick"
    local log_file="${LOGS_DIR}/brick_${task//,/_}_${DATE}.log"

    # Idempotency: skip if results already exist
    if find "${out_dir}" -name "results*.json" -print -quit 2>/dev/null | grep -q .; then
        echo "[SKIP] brick / ${task} — results exist in ${out_dir}"
        (( TOTAL_SKIP++ )) || true
        return 0
    fi

    mkdir -p "${out_dir}"

    local model_type="openai-chat-completions"
    local model_args="model=${MODEL},base_url=${BRICK_URL},tokenizer_backend=huggingface,tokenizer=${TOKENIZER},stream=false,max_tokens=${max_tokens},temperature=0,top_p=1"

    # Dry run: append --limit 5
    if [[ "${DRY_RUN}" == "true" ]]; then
        extra_flags+=(--limit 5)
    fi

    # Select system instruction based on benchmark
    local system_instruction
    system_instruction="$(get_system_instruction "${task}")"

    # Docker log timestamp — capture BEFORE running benchmark
    local ts_before
    ts_before=$(date -u +%Y-%m-%dT%H:%M:%S)

    echo "============================================================"
    echo "[RUN] brick / ${task}"
    echo "  Base URL: ${BRICK_URL}"
    echo "  Max tokens: ${max_tokens}"
    echo "  System instruction: ${system_instruction:0:80}..."
    echo "  Output: ${out_dir}"
    echo "  Log: ${log_file}"
    echo "  Docker log since: ${ts_before}"
    echo "  Started: $(date)"
    echo "============================================================"

    # IMPORTANT: Run lm-eval from /tmp to avoid CWD directory names
    # colliding with task names (lm-eval checks Path(task).is_dir()).
    # We invoke via python3 -c so we can import patch_parse_generations
    # first, which monkey-patches parse_generations to handle reasoning
    # model responses (content absent, only reasoning_content).
    VENV_PYTHON="/root/forkGO/semantic-routing/.venv/bin/python3"
    (cd /tmp && PYTHONPATH="${EVALS_DIR}:${PYTHONPATH:-}" \
        "${VENV_PYTHON}" -c "import patch_parse_generations; from lm_eval.__main__ import cli_evaluate; cli_evaluate()" \
        run \
        --model "${model_type}" \
        --model_args "${model_args}" \
        --tasks "${task}" \
        --include_path "${EVALS_DIR}/custom_tasks" \
        --output_path "${out_dir}" \
        --log_samples \
        --batch_size 1 \
        --apply_chat_template \
        --trust_remote_code \
        --system_instruction "${system_instruction}" \
        ${extra_flags[@]+"${extra_flags[@]}"} \
    ) 2>&1 | tee "${log_file}" || true

    local status=${PIPESTATUS[0]}

    # Capture Docker logs for this benchmark
    capture_docker_logs "${output_dir}" "${ts_before}"

    if [[ ${status} -eq 0 ]]; then
        echo "[DONE] brick / ${task} — SUCCESS ($(date))"
        (( TOTAL_RUN++ )) || true
    else
        echo "[FAIL] brick / ${task} — exit code ${status} ($(date))"
        (( TOTAL_FAIL++ )) || true
    fi

    return ${status}
}

##############################################################################
# Phase 1 — Core benchmarks (25% limits)
##############################################################################

phase1() {
    echo ""
    echo "################################################################"
    echo "# PHASE 1 — Core benchmarks (Brick only, 25% limits)"
    echo "################################################################"

    echo ""
    echo "=== MMLU-Pro (5-shot, limit=29/subtask ~406 total) ==="
    run_eval "mmlu_pro" "mmlu_pro" 2048 \
        --num_fewshot 5 \
        --limit 29 \
        --fewshot_as_multiturn True

    echo ""
    echo "=== ARC-Challenge Chat (0-shot, limit=293) ==="
    run_eval "arc_challenge_chat_nopfx" "arc_challenge" 256 \
        --limit 293

    echo ""
    echo "=== TruthfulQA Gen (6-shot built-in, limit=204) ==="
    run_eval "truthfulqa_gen" "truthfulqa" 256 \
        --limit 204
}

##############################################################################
# Phase 2 — Extended benchmarks (25% limits)
##############################################################################

phase2() {
    echo ""
    echo "################################################################"
    echo "# PHASE 2 — Extended benchmarks (Brick only, 25% limits)"
    echo "################################################################"

    echo ""
    echo "=== IFEval (0-shot, limit=135) ==="
    run_eval "ifeval" "ifeval" 1280 \
        --limit 135

    echo ""
    echo "=== BBH CoT Zeroshot (0-shot, limit=12/subtask) ==="
    run_eval "bbh_cot_zeroshot" "bbh" 2048 \
        --limit 12

    echo ""
    echo "=== DROP (3-shot, limit=50) ==="
    run_eval "drop" "drop" 2048 \
        --num_fewshot 3 \
        --limit 50 \
        --fewshot_as_multiturn True \
        --gen_kwargs '{"until":["\n\n"]}'

    echo ""
    echo "=== Minerva Math (4-shot, limit=25/subtask) ==="
    run_eval "minerva_math" "minerva_math" 2048 \
        --num_fewshot 4 \
        --limit 25 \
        --fewshot_as_multiturn True
}

##############################################################################
# Phase 3 — Code eval (25% limits)
##############################################################################

phase3() {
    echo ""
    echo "################################################################"
    echo "# PHASE 3 — Code eval (Brick only, 25% limits)"
    echo "################################################################"

    export HF_ALLOW_CODE_EVAL=1

    echo ""
    echo "=== HumanEval (0-shot, limit=41) ==="
    run_eval "humaneval" "humaneval" 1024 \
        --limit 41 \
        --confirm_run_unsafe_code

    echo ""
    echo "=== MBPP (3-shot, limit=125) ==="
    run_eval "mbpp" "mbpp" 512 \
        --num_fewshot 3 \
        --limit 125 \
        --fewshot_as_multiturn True \
        --confirm_run_unsafe_code
}

##############################################################################
# Phase 4 — Custom brick_general test (200 questions, full)
##############################################################################

phase4() {
    echo ""
    echo "################################################################"
    echo "# PHASE 4 — Custom brick_general test (200 questions, full)"
    echo "################################################################"

    echo ""
    echo "=== Brick General (0-shot, 200 questions, 5 categories) ==="
    run_eval "brick_general" "brick_general" 2048
}

##############################################################################
# Main
##############################################################################

echo "========================================"
echo " Piano Evals v3 — Brick only + Docker logs"
echo " Date:       ${DATE}"
echo " Phase:      ${PHASE}"
echo " Dry run:    ${DRY_RUN}"
echo " lm_eval:    ${LM_EVAL}"
echo " Brick URL:  ${BRICK_URL}"
echo " Stage dir:  ${STAGE_DIR}"
echo " Docker:     ${DOCKER_CONTAINER}"
echo "========================================"

case "${PHASE}" in
    1)   phase1 ;;
    2)   phase2 ;;
    3)   phase3 ;;
    4)   phase4 ;;
    all)
        phase1
        phase2
        phase3
        phase4
        ;;
    *)
        echo "ERROR: Invalid phase '${PHASE}'. Use 1, 2, 3, or all."
        exit 1
        ;;
esac

# Combine all JSONL docker logs into a single file
combine_docker_logs

echo ""
echo "========================================"
echo " Evaluation campaign complete!"
echo " Run:    ${TOTAL_RUN}"
echo " Skip:   ${TOTAL_SKIP}"
echo " Fail:   ${TOTAL_FAIL}"
echo " Results:     ${STAGE_DIR}/"
echo " Logs:        ${LOGS_DIR}/"
echo " Docker logs: ${DOCKER_LOGS_DIR}/"
echo " Token usage: ${USAGE_LOG_PATH}"
echo "========================================"

# Generate cost summary report
if [[ -f "${USAGE_LOG_PATH}" ]]; then
    echo ""
    echo "[SUMMARY] Generating cost & token summary..."
    python3 "${EVALS_DIR}/summarize_costs.py" \
        --usage "${USAGE_LOG_PATH}" \
        --results-dir "${STAGE_DIR}" \
        --output "${STAGE_DIR}/cost_summary.json" \
    || echo "[WARN] Cost summary generation failed"
fi
