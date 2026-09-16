#!/usr/bin/env python3
"""Apply best Brick V2 params to full 5504 dataset + emit RESULTS-ready metrics.

Reads sweep output, picks best row by holdout_accuracy, re-runs predict on
all rows (dev + holdout) using calibrated skill_vectors, prints summary +
per-dimension breakdown ready to paste into RESULTS.md.
"""

from __future__ import annotations

import argparse
import json
import os

# Import predict pipeline from sweep V2
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from sweep_brick_v2_wandb import (  # type: ignore
    SKILL_VECTORS_6,
    evaluate_prepared,
    prepare_arrays,
    rows_from_debug,
)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--sweep", type=Path, required=True, help="Output JSONL of sweep_brick_v2_wandb.py")
    parser.add_argument("--skills", type=Path, default=None, help="Skills JSON; if omitted uses production")
    parser.add_argument(
        "--input",
        type=Path,
        default=(Path(os.environ.get("BRICK_BASELINE_OUTPUT", "./baseline-output")) / "brick_debug_gpu.jsonl"),
    )
    parser.add_argument(
        "--comparison",
        type=Path,
        default=(Path(os.environ.get("BRICK_BASELINE_OUTPUT", "./baseline-output")) / "comparison.jsonl.gz"),
    )
    parser.add_argument("--top-k", type=int, default=10)
    args = parser.parse_args()

    rows = rows_from_debug(args.input, args.comparison)
    print(f"loaded {len(rows)} rows")

    if args.skills and args.skills.exists():
        with args.skills.open() as f:
            data = json.load(f)
        skill_vectors = {k: list(map(float, v)) for k, v in data["skill_vectors"].items()}
        print(f"using calibrated skills from {args.skills}")
    else:
        skill_vectors = SKILL_VECTORS_6
        print("using production skill vectors")

    arr = prepare_arrays(rows, skill_vectors)

    # Read sweep + sort by holdout_accuracy
    sweep_rows = []
    with args.sweep.open() as f:
        for line in f:
            if line.strip():
                sweep_rows.append(json.loads(line))
    sweep_rows.sort(key=lambda r: r["holdout_accuracy"], reverse=True)

    print(f"\n=== TOP {args.top_k} sweep configs by holdout_accuracy ===")
    for i, r in enumerate(sweep_rows[: args.top_k]):
        print(
            f"{i + 1}. holdout={r['holdout_accuracy']:.4f} dev={r['dev_accuracy']:.4f}"
            f"  pref={r['routing_preference']:.2f} mu={r['complexity_mu']:.2f}"
            f"  bias={r['complexity_bias']:.2f} beta={r['cost_penalty_beta']:.2f}"
            f"  lam={r['over_penalty_lambda']:.2f} tau={r['tau_base']:.2f}"
            f"  q={r['holdout_model_qwen_pct']:.2f} d={r['holdout_model_ds4_pct']:.2f} k={r['holdout_model_kimi_pct']:.2f}"
        )

    best = sweep_rows[0]
    print("\n=== BEST CONFIG ===")
    print(
        json.dumps(
            {
                k: best[k]
                for k in [
                    "routing_preference",
                    "complexity_mu",
                    "complexity_bias",
                    "cost_penalty_beta",
                    "over_penalty_lambda",
                    "tau_base",
                ]
            },
            indent=2,
        )
    )

    params = {
        "routing_preference": best["routing_preference"],
        "complexity_mu": best["complexity_mu"],
        "complexity_bias": best["complexity_bias"],
        "cost_penalty_beta": best["cost_penalty_beta"],
        "over_penalty_lambda": best["over_penalty_lambda"],
        "tau_base": best["tau_base"],
        "tau_override_mode": "raw",
    }
    full_metrics = evaluate_prepared(arr, params)

    print(f"\n=== APPLIED TO FULL {len(rows)} ROWS ===")
    print(f"accuracy        : {full_metrics['accuracy']:.4f}")
    print(f"avg_cost        : {full_metrics['avg_cost']:.4f}")
    print(f"cost_per_correct: {full_metrics['cost_per_correct']:.4f}")
    print(f"over_route_rate : {full_metrics['over_route_rate']:.4f}")
    print(f"under_route_rate: {full_metrics['under_route_rate']:.4f}")
    print(
        f"distribution    : qwen={full_metrics['model_qwen_pct']:.3f}  ds4={full_metrics['model_ds4_pct']:.3f}  kimi={full_metrics['model_kimi_pct']:.3f}"
    )
    print("\nPer-dimension accuracy:")
    for k in sorted(full_metrics):
        if k.startswith("acc_"):
            print(f"  {k[4:]:30s} : {full_metrics[k]:.4f}")


if __name__ == "__main__":
    main()
