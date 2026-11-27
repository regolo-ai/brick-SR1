"""Opt-in SMTP progress notifications with throttling."""

from __future__ import annotations

import argparse
import json
import os
import smtplib
import ssl
import sys
import time
from email.message import EmailMessage
from pathlib import Path

PASSWORD_FILE = Path(os.environ.get("BRICK_SMTP_PASSWORD_FILE", str(Path.home() / ".gmail_app_password")))
FROM = os.environ.get("BRICK_NOTIFY_FROM", "")
TO = os.environ.get("BRICK_NOTIFY_TO", "")
THROTTLE_FILE = Path(__file__).resolve().parent.parent.parent / "data" / ".last_email_ts"
MIN_INTERVAL_SEC = 15 * 60


def _load_password() -> str:
    return os.environ.get("BRICK_SMTP_PASSWORD") or PASSWORD_FILE.read_text().strip().replace(" ", "")


def _last_send_ts() -> float:
    if not THROTTLE_FILE.exists():
        return 0.0
    try:
        return float(THROTTLE_FILE.read_text().strip())
    except Exception:
        return 0.0


def _record_send(ts: float) -> None:
    THROTTLE_FILE.parent.mkdir(parents=True, exist_ok=True)
    THROTTLE_FILE.write_text(f"{ts:.0f}\n")


def send(subject: str, body: str, *, force: bool = False) -> bool:
    """Send email. Returns True if sent, False if throttled."""
    if not FROM or not TO:
        return False
    now = time.time()
    if not force and (now - _last_send_ts()) < MIN_INTERVAL_SEC:
        return False
    msg = EmailMessage()
    msg["Subject"] = f"[Dataset B] {subject}"
    msg["From"] = FROM
    msg["To"] = TO
    msg.set_content(body)
    with smtplib.SMTP("smtp.gmail.com", 587, timeout=30) as s:
        s.starttls(context=ssl.create_default_context())
        s.login(FROM, _load_password())
        s.send_message(msg)
    _record_send(now)
    return True


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--subject", required=False, default="test")
    ap.add_argument("--body", required=False, default="test body")
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--test", action="store_true", help="send a hardcoded test email")
    args = ap.parse_args()
    if args.test:
        ok = send(
            "Pipeline orchestrator online",
            "Training progress notifications are configured.",
            force=True,
        )
    else:
        ok = send(args.subject, args.body, force=args.force)
    print(json.dumps({"sent": ok}))
    return 0 if ok else 2


if __name__ == "__main__":
    sys.exit(main())
