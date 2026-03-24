#!/usr/bin/env bash
# Monitora la sessione tmux large-qwen3_5-9b e invia email al termine.
SESSION="large-qwen3_5-9b"
NOTIFY="/root/forkGO/semantic-routing/evals/stage8_large/notify_done.py"
LOG="/root/forkGO/semantic-routing/evals/stage8_large/qwen3.5-9b.log"

echo "[watch] In attesa che la sessione '$SESSION' termini..."

while tmux has-session -t "$SESSION" 2>/dev/null; do
    sleep 30
done

echo "[watch] Sessione terminata. Controllo log..."

# Determina se il run e' andato a buon fine
if grep -q "DONE" "$LOG" 2>/dev/null; then
    STATUS="DONE (successo)"
elif grep -q "ERROR\|error\|Traceback\|502\|failed" "$LOG" 2>/dev/null; then
    STATUS="ERRORE"
else
    STATUS="TERMINATO (stato sconosciuto)"
fi

echo "[watch] Status: $STATUS — invio email..."
python3 "$NOTIFY" "$STATUS"
