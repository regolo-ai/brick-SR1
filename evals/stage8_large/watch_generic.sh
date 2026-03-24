#!/usr/bin/env bash
# Uso: watch_generic.sh <session_name> <model_id> <gmail_app_password>
# Monitora sessione tmux e invia email al termine.
SESSION="$1"
MODEL_ID="$2"
export GMAIL_APP_PASSWORD="$3"

EVALS_DIR="/root/forkGO/semantic-routing/evals"
NOTIFY="${EVALS_DIR}/stage8_large/notify_done.py"
SAFE="${MODEL_ID//\//_}"
LOG="${EVALS_DIR}/stage8_large/${SAFE}.log"

echo "[watch:${MODEL_ID}] In attesa che la sessione '${SESSION}' termini..."

while tmux has-session -t "${SESSION}" 2>/dev/null; do
    sleep 30
done

echo "[watch:${MODEL_ID}] Sessione terminata. Controllo log..."

if grep -q "DONE" "${LOG}" 2>/dev/null; then
    STATUS="DONE (successo)"
elif grep -q "ERROR\|Traceback\|502\|failed" "${LOG}" 2>/dev/null; then
    STATUS="ERRORE"
else
    STATUS="TERMINATO (stato sconosciuto)"
fi

echo "[watch:${MODEL_ID}] Status: ${STATUS} — invio email..."

NOTIFY_SCRIPT=$(cat << PYEOF
import smtplib, sys, os
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart

GMAIL_USER = "francescomassa06@gmail.com"
GMAIL_APP_PASSWORD = os.environ.get("GMAIL_APP_PASSWORD", "")
TO = "francescomassa06@gmail.com"
MODEL_ID = "${MODEL_ID}"
LOG_FILE = "${LOG}"
STATUS = "${STATUS}"

def read_summary():
    try:
        with open(LOG_FILE) as f:
            lines = f.readlines()
        tail = "".join(lines[-40:])
        for line in reversed(lines):
            if any(k in line.lower() for k in ["acc", "accuracy", "exact_match"]):
                return line.strip(), tail
        return "(nessun risultato trovato nel log)", tail
    except Exception as e:
        return f"(errore lettura log: {e})", ""

result_line, tail = read_summary()

subject = f"[brick_large] {MODEL_ID} — {STATUS}"
body = f"""Il benchmark brick_large per {MODEL_ID} ha terminato con stato: {STATUS}

Risultato:
{result_line}

--- Ultime righe del log ---
{tail}
"""

msg = MIMEMultipart()
msg["From"] = GMAIL_USER
msg["To"] = TO
msg["Subject"] = subject
msg.attach(MIMEText(body, "plain"))

with smtplib.SMTP("smtp.gmail.com", 587) as smtp:
    smtp.starttls()
    smtp.login(GMAIL_USER, GMAIL_APP_PASSWORD)
    smtp.send_message(msg)
print(f"[OK] Email inviata a {TO} per {MODEL_ID}")
PYEOF
)

python3 -c "${NOTIFY_SCRIPT}"
