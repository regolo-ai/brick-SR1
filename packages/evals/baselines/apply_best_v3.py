#!/usr/bin/env python3
"""Apply V3 per-cap params to full 5504 + emit metrics ready for RESULTS.md."""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from sweep_brick_v2_wandb import (  # type: ignore
    BASE_CAPABILITIES,
    calibrate_skills,
    rows_from_debug,
    split_rows,
)
from sweep_brick_v3_percap import evaluate_percap, prepare_arrays  # type: ignore


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--sweep", type=Path, required=True)
    p.add_argument(
        "--input",
        type=Path,
        default=(Path(os.environ.get("BRICK_BASELINE_OUTPUT", "./baseline-output")) / "brick_debug_gpu.jsonl"),
    )
    p.add_argument(
        "--comparison",
        type=Path,
        default=(Path(os.environ.get("BRICK_BASELINE_OUTPUT", "./baseline-output")) / "comparison.jsonl.gz"),
    )
    p.add_argument("--dev-fraction", type=float, default=0.70)
    p.add_argument("--seed", default="brick-v3-percap")
    p.add_argument("--top-k", type=int, default=5)
    args = p.parse_args()

    rows = rows_from_debug(args.input, args.comparison)
    print(f"loaded {len(rows)} rows")
    dev, holdout = split_rows(rows, args.dev_fraction, args.seed)
    skills = calibrate_skills(dev)
    full_arr = prepare_arrays(rows, skills)

    # Top by holdout
    sweep_rows = []
    with args.sweep.open() as f:
        for line in f:
            if line.strip():
                sweep_rows.append(json.loads(line))
    sweep_rows.sort(key=lambda r: r["holdout_accuracy"], reverse=True)
    print(f"sweep rows: {len(sweep_rows)}")

    print(f"\n=== TOP {args.top_k} ===")
    for i, r in enumerate(sweep_rows[: args.top_k]):
        print(
            f"{i + 1}. holdout={r['holdout_accuracy']:.4f} dev={r['dev_accuracy']:.4f}"
            f"  q={r['holdout_model_qwen_pct']:.2f} d={r['holdout_model_ds4_pct']:.2f} k={r['holdout_model_kimi_pct']:.2f}"
        )

    best = sweep_rows[0]
    params = {
        k: best[k]
        for k in [
            "routing_preference",
            "complexity_mu",
            "complexity_bias",
            "cost_penalty_beta",
            "over_penalty_lambda",
            "tau_base",
        ]
    }
    mu_per_cap = np.array([best[f"mu_{c}"] for c in BASE_CAPABILITIES])
    bias_per_cap = np.array([best[f"bias_{c}"] for c in BASE_CAPABILITIES])

    print("\n=== BEST CONFIG ===")
    print(f"global: {json.dumps(params, indent=2)}")
    print(f"mu_per_cap   : {dict(zip(BASE_CAPABILITIES, mu_per_cap.tolist(), strict=False))}")
    print(f"bias_per_cap : {dict(zip(BASE_CAPABILITIES, bias_per_cap.tolist(), strict=False))}")

    full_m = evaluate_percap(full_arr, params, mu_per_cap, bias_per_cap)
    print(f"\n=== APPLIED FULL {len(rows)} ROWS ===")
    print(f"accuracy        : {full_m['accuracy']:.4f}")
    print(f"avg_cost        : {full_m['avg_cost']:.4f}")
    print(f"cost_per_correct: {full_m['cost_per_correct']:.4f}")
    print(f"over_route_rate : {full_m['over_route_rate']:.4f}")
    print(f"under_route_rate: {full_m['under_route_rate']:.4f}")
    print(
        f"distribution    : qwen={full_m['model_qwen_pct']:.3f}  ds4={full_m['model_ds4_pct']:.3f}  kimi={full_m['model_kimi_pct']:.3f}"
    )
    print("\nPer-dimension accuracy:")
    for k in sorted(full_m):
        if k.startswith("acc_"):
            print(f"  {k[4:]:30s} : {full_m[k]:.4f}")

    # Cross-validation with different seed (overfit check)
    dev2, hold2 = split_rows(rows, args.dev_fraction, args.seed + "_check")
    skills2 = calibrate_skills(dev2)
    hold2_arr = prepare_arrays(hold2, skills2)
    cross_m = evaluate_percap(hold2_arr, params, mu_per_cap, bias_per_cap)
    print("\n=== CROSS-CHECK (different seed split) ===")
    print(
        f"holdout_accuracy with different split: {cross_m['accuracy']:.4f}  (orig holdout {best['holdout_accuracy']:.4f}, gap = {abs(cross_m['accuracy'] - best['holdout_accuracy']):.4f})"
    )


if __name__ == "__main__":
    main()
