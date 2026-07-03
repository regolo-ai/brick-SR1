"""Poll W&B Sweep API, send milestone email (25/50/75/100%) via notify.py.

Run as background process locally:
    nohup python sweep_email_monitor.py \
        --sweep massa-industries/dataset-b-modernbert/0srgzjrg \
        --target 50 &
"""

from __future__ import annotations

import argparse
import os
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts" / "utils"))
from notify import send  # noqa: E402


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--sweep", required=True, help="entity/project/sweep_id")
    ap.add_argument("--target", type=int, default=50, help="expected runs total")
    ap.add_argument("--interval", type=int, default=1800, help="poll seconds")
    args = ap.parse_args()

    os.environ.setdefault("WANDB_API_KEY", Path("/root/.wandb_key").read_text().strip())
    import wandb

    api = wandb.Api()

    seen_milestones = set()
    while True:
        try:
            sweep = api.sweep(args.sweep)
            finished = [r for r in sweep.runs if r.state in ("finished", "killed", "crashed")]
            running = [r for r in sweep.runs if r.state == "running"]
            best = None
            for r in finished:
                pm = r.summary.get("eval/pearson_macro")
                if pm is not None and (best is None or pm > best[1]):
                    best = (r.id, pm)

            pct = int(100 * len(finished) / args.target) if args.target else 0
            for ms in (25, 50, 75, 100):
                if pct >= ms and ms not in seen_milestones:
                    seen_milestones.add(ms)
                    subj = f"[Sweep {ms}%] ModernBERT capability {len(finished)}/{args.target} runs done"
                    body = (
                        f"Sweep: {args.sweep}\n"
                        f"Finished: {len(finished)}\nRunning: {len(running)}\n"
                        f"Best so far: {best}\n"
                        f"URL: https://wandb.ai/{args.sweep.replace('/', '/sweeps/', 1).replace('/sweeps/', '/sweeps/', 1)}\n"
                    )
                    try:
                        send(subj, body, force=True)
                        print(f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] sent milestone {ms}% email")
                    except Exception as e:
                        print(f"email error: {e}")

            print(
                f"[{time.strftime('%H:%M:%S')}] finished={len(finished)} running={len(running)} pct={pct}% best={best}"
            )
            if pct >= 100:
                break
        except Exception as e:
            print(f"poll error: {e}")
        time.sleep(args.interval)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
