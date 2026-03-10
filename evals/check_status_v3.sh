#!/usr/bin/env bash
#
# check_status_v3.sh — Check progress of eval v3 (stage6)
#
# Usage: ./check_status_v3.sh
#        watch -n 10 ./check_status_v3.sh   # auto-refresh every 10s
#

EVALS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STAGE_DIR="${EVALS_DIR}/stage6"
LOGS_DIR="${STAGE_DIR}/logs"
DOCKER_LOGS_DIR="${STAGE_DIR}/docker_logs"
TMUX_SESSION="evals-v3"

# All benchmarks in execution order (task_name -> output_dir)
declare -A TASK_TO_DIR=(
    [mmlu_pro]="mmlu_pro"
    [arc_challenge_chat_nopfx]="arc_challenge"
    [truthfulqa_gen]="truthfulqa"
    [ifeval]="ifeval"
    [bbh_cot_zeroshot]="bbh"
    [drop]="drop"
    [minerva_math]="minerva_math"
    [humaneval]="humaneval"
    [mbpp]="mbpp"
    [brick_general]="brick_general"
)

# Ordered list (bash associative arrays don't preserve order)
BENCHMARKS=(mmlu_pro arc_challenge_chat_nopfx truthfulqa_gen ifeval bbh_cot_zeroshot drop minerva_math humaneval mbpp brick_general)
DISPLAY_NAMES=(mmlu_pro arc_challenge truthfulqa ifeval bbh drop minerva_math humaneval mbpp brick_general)

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

echo ""
echo "=========================================="
echo " Eval V3 — Stage 6 Progress"
echo " $(date)"
echo "=========================================="

# Check tmux session
if tmux has-session -t "${TMUX_SESSION}" 2>/dev/null; then
    echo -e " tmux session: ${GREEN}RUNNING${NC}  (tmux attach -t ${TMUX_SESSION})"
else
    echo -e " tmux session: ${YELLOW}NOT RUNNING${NC}"
fi
echo ""

# Table header
printf "  %-16s  %-10s  %6s  %8s  %s\n" "BENCHMARK" "STATUS" "PROG" "DOCKER" "DETAILS"
printf "  %-16s  %-10s  %6s  %8s  %s\n" "────────────────" "──────────" "──────" "────────" "───────────────────"

DONE=0
RUNNING=0
PENDING=0
FAILED=0

for i in "${!BENCHMARKS[@]}"; do
    task="${BENCHMARKS[$i]}"
    display="${DISPLAY_NAMES[$i]}"
    out_dir="${TASK_TO_DIR[$task]}"
    result_dir="${STAGE_DIR}/${out_dir}/brick"

    # Find log file
    log=$(ls -t "${LOGS_DIR}"/brick_${task/,/_}_*.log 2>/dev/null | head -1)

    # Check for results
    has_results=false
    if find "${result_dir}" -name "results*.json" -print -quit 2>/dev/null | grep -q .; then
        has_results=true
    fi

    # Check for docker logs
    docker_log="${DOCKER_LOGS_DIR}/${out_dir}.jsonl"
    docker_lines="-"
    if [[ -f "${docker_log}" ]]; then
        docker_lines="$(wc -l < "${docker_log}")L"
    fi

    # Determine status
    if [[ "${has_results}" == "true" ]]; then
        status="${GREEN}DONE${NC}"
        details=""
        # Try to extract score from results
        results_file=$(find "${result_dir}" -name "results*.json" -print -quit 2>/dev/null)
        if [[ -n "${results_file}" ]]; then
            # Extract main metric
            score=$(python3 -c "
import json, sys
try:
    with open('${results_file}') as f:
        r = json.load(f)
    results = r.get('results', {})
    # Get first result with acc or exact_match
    for task_name, metrics in results.items():
        for key in ['acc,none', 'exact_match,none', 'pass@1,none', 'prompt_level_strict_acc,none', 'bleu,none', 'mc2']:
            if key in metrics:
                val = metrics[key]
                print(f'{key.split(\",\")[0]}={val:.1%}' if isinstance(val, float) else f'{key}={val}')
                sys.exit(0)
    print('')
except: print('')
" 2>/dev/null)
            details="${score}"
        fi
        (( DONE++ )) || true
    elif [[ -n "${log}" ]]; then
        # Check progress from log
        progress_line=$(grep -oP 'Requesting API:\s+\d+%\|[^|]*\|\s*\d+/\d+\s+\[[^\]]+\]' "${log}" 2>/dev/null | tail -1)

        if [[ -n "${progress_line}" ]]; then
            current=$(echo "${progress_line}" | grep -oP '\|\s*\K\d+(?=/)')
            total=$(echo "${progress_line}" | grep -oP '/\K\d+(?=\s)')
            pct=$(echo "${progress_line}" | grep -oP '\d+(?=%)')
            eta=$(echo "${progress_line}" | grep -oP '<\K[^,\]]+')

            status="${CYAN}RUNNING${NC}"
            details="${current:-?}/${total:-?} (${pct:-?}%) ETA ${eta:-?}"
            (( RUNNING++ )) || true
        elif grep -q "Saving results" "${log}" 2>/dev/null; then
            status="${GREEN}DONE${NC}"
            details="saving..."
            (( DONE++ )) || true
        elif grep -qi "error\|traceback\|exception\|FAIL" "${log}" 2>/dev/null; then
            err=$(grep -iP 'error|exception' "${log}" 2>/dev/null | tail -1 | head -c 50)
            status="${RED}FAILED${NC}"
            details="${err}"
            (( FAILED++ )) || true
        else
            status="${CYAN}RUNNING${NC}"
            details="initializing..."
            (( RUNNING++ )) || true
        fi
    else
        status="${YELLOW}PENDING${NC}"
        details=""
        (( PENDING++ )) || true
    fi

    printf "  %-16s  ${status}%-*s  %6s  %8s  %s\n" \
        "${display}" $((10 - 9)) "" "${docker_lines}" "" "${details}"
done

echo ""
printf "  Summary: ${GREEN}%d done${NC}  ${CYAN}%d running${NC}  ${YELLOW}%d pending${NC}  ${RED}%d failed${NC}  (of %d total)\n" \
    "${DONE}" "${RUNNING}" "${PENDING}" "${FAILED}" "${#BENCHMARKS[@]}"

# Docker logs summary
if [[ -d "${DOCKER_LOGS_DIR}" ]]; then
    jsonl_count=$(ls "${DOCKER_LOGS_DIR}"/*.jsonl 2>/dev/null | grep -v all_benchmarks_combined | wc -l)
    combined="${DOCKER_LOGS_DIR}/all_benchmarks_combined.jsonl"
    if [[ -f "${combined}" ]]; then
        combined_lines=$(wc -l < "${combined}")
        echo -e "  Docker logs: ${jsonl_count} benchmark files, ${combined_lines} combined lines"
    elif [[ ${jsonl_count} -gt 0 ]]; then
        echo -e "  Docker logs: ${jsonl_count} benchmark files (not yet combined)"
    fi
fi

# Disk usage
if [[ -d "${STAGE_DIR}" ]]; then
    du_size=$(du -sh "${STAGE_DIR}" 2>/dev/null | cut -f1)
    echo "  Disk usage: ${du_size} in ${STAGE_DIR}/"
fi

echo ""
