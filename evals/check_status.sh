#!/usr/bin/env bash
#
# check_status.sh — Monitor parallel eval progress
#
# Usage:
#   ./check_status.sh          # Show status of all models
#   ./check_status.sh --logs   # Also show last 3 lines of each log
#
# Exit codes:
#   0 — All models completed
#   1 — Some models still running or not started
#
set -eo pipefail

EVALS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STAGE2_DIR="${EVALS_DIR}/stage2"

SHOW_LOGS=false
if [[ "${1:-}" == "--logs" ]]; then
    SHOW_LOGS=true
fi

##############################################################################
# Configuration
##############################################################################

SHORT_NAMES=(brick llama70b gptoss120b gptoss20b mistral32 qwen3coder qwen3_8b)

# All benchmark output subdirs
ALL_BENCHMARKS=(mmlu_pro arc_challenge truthfulqa ifeval bbh drop minerva_math)
CODE_BENCHMARKS=(humaneval mbpp)

# Models that run code eval
CODE_EVAL_SHORTS="brick llama70b qwen3coder"

##############################################################################
# Status check
##############################################################################

ALL_DONE=true
TOTAL_COMPLETED=0
TOTAL_EXPECTED=0

printf "\n"
printf "%-14s %-10s %-12s %s\n" "MODEL" "STATUS" "COMPLETED" "BENCHMARKS DONE"
printf "%-14s %-10s %-12s %s\n" "─────────────" "─────────" "───────────" "──────────────────────────────────────────"

for short in "${SHORT_NAMES[@]}"; do
    session_name="eval-${short}"

    # Check tmux session status
    if tmux has-session -t "${session_name}" 2>/dev/null; then
        status="running"
    else
        status="done"
    fi

    # Determine expected benchmarks for this model
    is_code_model=false
    for cm in ${CODE_EVAL_SHORTS}; do
        if [[ "${short}" == "${cm}" ]]; then
            is_code_model=true
            break
        fi
    done

    if [[ "${is_code_model}" == "true" ]]; then
        expected=9
    else
        expected=7
    fi

    # Count completed benchmarks (those with results*.json)
    completed=0
    completed_names=()

    for bench in "${ALL_BENCHMARKS[@]}"; do
        dir="${STAGE2_DIR}/${bench}/${short}"
        if [[ -d "${dir}" ]] && find "${dir}" -name "results*.json" -print -quit 2>/dev/null | grep -q .; then
            completed=$((completed + 1))
            completed_names+=("${bench}")
        fi
    done

    if [[ "${is_code_model}" == "true" ]]; then
        for bench in "${CODE_BENCHMARKS[@]}"; do
            dir="${STAGE2_DIR}/${bench}/${short}"
            if [[ -d "${dir}" ]] && find "${dir}" -name "results*.json" -print -quit 2>/dev/null | grep -q .; then
                completed=$((completed + 1))
                completed_names+=("${bench}")
            fi
        done
    fi

    TOTAL_COMPLETED=$((TOTAL_COMPLETED + completed))
    TOTAL_EXPECTED=$((TOTAL_EXPECTED + expected))

    # Format completed benchmarks list
    if [[ ${#completed_names[@]} -eq 0 ]]; then
        bench_list="-"
    elif [[ ${completed} -eq ${expected} ]]; then
        bench_list="(all)"
    else
        bench_list=$(IFS=,; echo "${completed_names[*]}")
    fi

    # Mark if not fully done
    if [[ ${completed} -lt ${expected} ]]; then
        ALL_DONE=false
    fi

    printf "%-14s %-10s %-12s %s\n" "${short}" "${status}" "${completed}/${expected}" "${bench_list}"
done

printf "\n"
printf "Total progress: %d/%d benchmarks completed\n" "${TOTAL_COMPLETED}" "${TOTAL_EXPECTED}"
printf "\n"

##############################################################################
# Log tails (optional)
##############################################################################

if [[ "${SHOW_LOGS}" == "true" ]]; then
    echo "═══════════════════════════════════════════════════════════"
    echo " Last 3 lines of each model's log"
    echo "═══════════════════════════════════════════════════════════"

    for short in "${SHORT_NAMES[@]}"; do
        # Find the most recent log for this model (covers both _all_ and _retry_ logs)
        log_file=$(ls -t "${STAGE2_DIR}/logs/${short}_"*.log 2>/dev/null | head -1)

        echo ""
        echo "--- ${short} ---"
        if [[ -n "${log_file}" && -f "${log_file}" ]]; then
            tail -3 "${log_file}"
        else
            echo "  (no log file found)"
        fi
    done
    echo ""
fi

##############################################################################
# Active tmux sessions
##############################################################################

echo "═══════════════════════════════════════════════════════════"
echo " Active tmux eval sessions"
echo "═══════════════════════════════════════════════════════════"

if tmux ls 2>/dev/null | grep "^eval-"; then
    :
else
    echo "  (no eval sessions found)"
fi
echo ""

##############################################################################
# Exit code
##############################################################################

if [[ "${ALL_DONE}" == "true" ]]; then
    echo "All benchmarks completed!"
    exit 0
else
    echo "Some benchmarks still in progress..."
    exit 1
fi
