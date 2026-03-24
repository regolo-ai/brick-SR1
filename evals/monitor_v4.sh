#!/usr/bin/env bash
# monitor_v4.sh — live progress monitor for evals-hard-v4
SESSION="evals-hard-v4"
MODELS=(gpt-oss-120b gpt-oss-20b qwen3-8b Llama-3.3-70B-Instruct mistral-small3.2 qwen3-coder-next)

while true; do
    clear
    echo "╔══════════════════════════════════════════════════════════════════╗"
    echo "║           evals-hard-v4  —  MMLU-Pro 200q  —  $(date '+%H:%M:%S')          ║"
    echo "╠══════════════════════════════════════════════════════════════════╣"
    printf "║  %-28s  %-10s  %-20s  ║\n" "MODEL" "PROGRESS" "ETA"
    echo "╠══════════════════════════════════════════════════════════════════╣"

    all_done=true
    for idx in "${!MODELS[@]}"; do
        model="${MODELS[$idx]}"
        line=$(tmux capture-pane -t "${SESSION}:${idx}" -p 2>/dev/null | grep -E "Requesting API:|=== DONE" | tail -1)

        if echo "$line" | grep -q "DONE"; then
            printf "║  %-28s  %-10s  %-20s  ║\n" "${model}" "✅ DONE" "—"
        elif echo "$line" | grep -q "Requesting API:"; then
            pct=$(echo "$line"  | grep -oP '\d+(?=%)')
            cur=$(echo "$line"  | grep -oP '\d+(?=/)' | tail -1)
            tot=$(echo "$line"  | grep -oP '(?<=/)\d+' | head -1)
            eta=$(echo "$line"  | grep -oP '(?<=<)[0-9:]+(?=,)' | tail -1)
            rate=$(echo "$line" | grep -oP '[\d.]+(?=s/it|it/s)')
            unit=$(echo "$line" | grep -oP 's/it|it/s' | head -1)
            bar_filled=$(( pct * 20 / 100 ))
            bar=$(printf '█%.0s' $(seq 1 $bar_filled 2>/dev/null); printf '░%.0s' $(seq 1 $(( 20 - bar_filled )) 2>/dev/null))
            printf "║  %-28s  %3s%%  %s  ETA %-8s  ║\n" "${model}" "${pct}" "${bar}" "${eta:-?}"
            all_done=false
        else
            printf "║  %-28s  %-10s  %-20s  ║\n" "${model}" "⏳ starting…" "—"
            all_done=false
        fi
    done

    echo "╚══════════════════════════════════════════════════════════════════╝"
    echo "  Ctrl+C to exit"

    if [ "$all_done" = true ]; then
        echo ""
        echo "  🎉 All models finished!"
        break
    fi

    sleep 5
done
