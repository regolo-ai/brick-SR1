#!/usr/bin/env python3
"""Invia email di notifica quando il benchmark qwen3.5-9b termina."""
import smtplib
import sys
import os
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart

GMAIL_USER = "francescomassa06@gmail.com"
GMAIL_APP_PASSWORD = os.environ.get("GMAIL_APP_PASSWORD", "")
TO = "francescomassa06@gmail.com"

LOG_FILE = "/root/forkGO/semantic-routing/evals/stage8_large/qwen3.5-9b.log"


def read_summary():
    try:
        with open(LOG_FILE) as f:
            lines = f.readlines()
        tail = "".join(lines[-40:])
        # cerca la riga con accuracy
        for line in reversed(lines):
            if "acc" in line.lower() or "accuracy" in line.lower() or "exact_match" in line.lower():
                return line.strip(), tail
        return "(nessun risultato trovato nel log)", tail
    except Exception as e:
        return f"(errore lettura log: {e})", ""


def send(subject, body):
    if not GMAIL_APP_PASSWORD:
        print("[ERROR] GMAIL_APP_PASSWORD non impostata. Esporta la variabile e riprova.")
        sys.exit(1)

    msg = MIMEMultipart()
    msg["From"] = GMAIL_USER
    msg["To"] = TO
    msg["Subject"] = subject
    msg.attach(MIMEText(body, "plain"))

    with smtplib.SMTP("smtp.gmail.com", 587) as smtp:
        smtp.starttls()
        smtp.login(GMAIL_USER, GMAIL_APP_PASSWORD)
        smtp.send_message(msg)
    print(f"[OK] Email inviata a {TO}")


if __name__ == "__main__":
    status = sys.argv[1] if len(sys.argv) > 1 else "COMPLETATO"
    result_line, tail = read_summary()

    subject = f"[brick_large] qwen3.5-9b — {status}"
    body = f"""Il benchmark brick_large per qwen3.5-9b ha terminato con stato: {status}

Risultato:
{result_line}

--- Ultime righe del log ---
{tail}
"""
    send(subject, body)
