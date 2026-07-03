"""Post-sweep: pick top-3 runs by val pearson_macro, download best ckpts.

Usage:
    python select_top3.py --project dataset-b-modernbert --sweep <SWEEP_ID>
"""

from __future__ import annotations

import argparse
import json
import shutil
from pathlib import Path


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--project", required=True)
    ap.add_argument("--sweep", required=True, help="W&B sweep ID")
    ap.add_argument("--output-dir", default="outputs/top3")
    args = ap.parse_args()

    import wandb

    api = wandb.Api()
    sweep = api.sweep(f"{args.project}/{args.sweep}")
    runs = sorted(
        [r for r in sweep.runs if r.state == "finished" and r.summary.get("eval/pearson_macro") is not None],
        key=lambda r: r.summary["eval/pearson_macro"],
        reverse=True,
    )[:3]

    out_root = Path(args.output_dir)
    out_root.mkdir(parents=True, exist_ok=True)
    summary = []
    for i, run in enumerate(runs, start=1):
        rank_dir = out_root / f"rank{i}"
        rank_dir.mkdir(exist_ok=True)
        # Try to grab local artifact: run dir typically under wandb/run-<id>
        # In SkyPilot launch context, models live in outputs/modernbert-{size}/best/
        size = run.config.get("model_size", "base")
        src = Path(f"outputs/modernbert-{size}/best")
        if src.exists():
            shutil.copytree(src, rank_dir / "best", dirs_exist_ok=True)
        summary.append(
            {
                "rank": i,
                "run_id": run.id,
                "name": run.name,
                "config": dict(run.config),
                "pearson_macro": run.summary["eval/pearson_macro"],
                "mae_macro": run.summary.get("eval/mae_macro"),
                "local_ckpt": str(rank_dir / "best") if src.exists() else None,
            }
        )
    (out_root / "summary.json").write_text(json.dumps(summary, indent=2))
    print(json.dumps(summary, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
