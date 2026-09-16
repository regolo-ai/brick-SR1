#!/usr/bin/env python3
"""Honest 3-way split eval: skills calibrated on TRAIN, model selection on VAL,
final reported accuracy on TEST (held out throughout selection).

Logs to W&B for tracking. Compares V2 (global) vs V3 (per-cap) honestly.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import random
import sys
import time
from collections import defaultdict
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from sweep_brick_v2_wandb import (  # type: ignore
    BASE_CAPABILITIES,
    COMPARISON_INPUT,
    DEBUG_INPUT,
    MODELS,
    calibrate_skills,
    rows_from_debug,
)
from sweep_brick_v3_percap import evaluate_percap, prepare_arrays  # type: ignore


def split_3way(rows, train_frac: float, val_frac: float, seed: str):
    by_dim: dict[str, list] = defaultdict(list)
    for row in rows:
        by_dim[row["dimension"]].append(row)
    train, val, test = [], [], []
    for dim_rows in by_dim.values():
        ordered = sorted(
            dim_rows,
            key=lambda r: hashlib.sha256(f"{seed}:{r['query_id']}".encode()).hexdigest(),
        )
        n = len(ordered)
        n_train = int(round(n * train_frac))
        n_val = int(round(n * val_frac))
        train.extend(ordered[:n_train])
        val.extend(ordered[n_train : n_train + n_val])
        test.extend(ordered[n_train + n_val :])
    return train, val, test


def evaluate_global(data, params, n_caps: int):
    """V2-style eval: global mu, no per-cap multipliers."""
    mu_per_cap = np.ones(n_caps)
    bias_per_cap = np.zeros(n_caps)
    return evaluate_percap(data, params, mu_per_cap, bias_per_cap)


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--input", type=Path, default=DEBUG_INPUT)
    p.add_argument("--comparison", type=Path, default=COMPARISON_INPUT)
    p.add_argument("--train-frac", type=float, default=0.60)
    p.add_argument("--val-frac", type=float, default=0.20)
    p.add_argument("--seed", default="brick-3way")
    p.add_argument("--mode", choices=["v2_grid", "v3_random"], default="v2_grid")
    p.add_argument("--trials", type=int, default=10000, help="for v3_random")
    p.add_argument("--wandb-mode", choices=["disabled", "offline", "online"], default="online")
    p.add_argument("--run-name", default=None)
    p.add_argument(
        "--out",
        type=Path,
        default=(Path(os.environ.get("BRICK_BASELINE_OUTPUT", "./baseline-output")) / "brick_3way_results.json"),
    )
    args = p.parse_args()

    rows = rows_from_debug(args.input, args.comparison)
    train, val, test = split_3way(rows, args.train_frac, args.val_frac, args.seed)
    print(f"[load] rows={len(rows)} train={len(train)} val={len(val)} test={len(test)}")

    skill_vectors = calibrate_skills(train)
    print(f"[skills] calibrated on TRAIN ({len(train)})")
    train_arr = prepare_arrays(train, skill_vectors)
    val_arr = prepare_arrays(val, skill_vectors)
    test_arr = prepare_arrays(test, skill_vectors)

    if args.wandb_mode != "disabled":
        os.environ["WANDB_MODE"] = args.wandb_mode
        if args.wandb_mode == "online" and not os.environ.get("WANDB_API_KEY"):
            kp = Path.home() / ".wandb_key"
            if kp.exists():
                os.environ["WANDB_API_KEY"] = kp.read_text().strip()
        import wandb

        run = wandb.init(
            entity="massa-industries",
            project="brick-risk-adjusted-routing",
            name=args.run_name or f"3way-{args.mode}-seed{args.seed}",
            job_type="honest_3way",
            tags=["honest", args.mode, "calibrated_on_train"],
            config={
                "seed": args.seed,
                "train_frac": args.train_frac,
                "val_frac": args.val_frac,
                "mode": args.mode,
                "trials": args.trials,
            },
        )
    else:
        wandb = None
        run = None

    best = {"val_accuracy": -1, "params": None, "mu_per_cap": None, "bias_per_cap": None}
    n_caps = len(BASE_CAPABILITIES)
    t0 = time.time()

    if args.mode == "v2_grid":
        # Full V2 grid (same as fullgrid)
        from sweep_brick_v2_wandb import grid_combinations  # type: ignore

        combos = grid_combinations(quick=False, tau_sweep=True)
        print(f"[v2_grid] {len(combos)} combos")
        for i, params in enumerate(combos):
            params["tau_override_mode"] = "raw"
            val_m = evaluate_global(val_arr, params, n_caps)
            if val_m["accuracy"] > best["val_accuracy"]:
                best["val_accuracy"] = val_m["accuracy"]
                best["params"] = dict(params)
                best["mu_per_cap"] = [1.0] * n_caps
                best["bias_per_cap"] = [0.0] * n_caps
            if (i + 1) % (len(combos) // 10 + 1) == 0:
                print(f"  [{i + 1}/{len(combos)}] best_val={best['val_accuracy']:.4f}  elapsed={time.time() - t0:.1f}s")
    else:
        # V3 random per-cap
        rnd = random.Random(args.seed)
        for i in range(args.trials):
            params = {
                "routing_preference": max(-1.0, min(1.0, -0.5 + rnd.gauss(0, 0.3))),
                "complexity_mu": max(0.05, 0.25 + rnd.gauss(0, 0.30)),
                "complexity_bias": 0.30 + rnd.gauss(0, 0.40),
                "cost_penalty_beta": max(0.0, 0.02 + abs(rnd.gauss(0, 0.10))),
                "over_penalty_lambda": max(0.0, 0.20 + abs(rnd.gauss(0, 0.30))),
                "tau_base": max(0.30, min(0.97, 0.50 + rnd.gauss(0, 0.15))),
                "tau_override_mode": "raw",
            }
            mu_per_cap = np.array([math.exp(rnd.gauss(0, 0.5)) for _ in BASE_CAPABILITIES])
            bias_per_cap = np.array([rnd.gauss(0, 0.3) for _ in BASE_CAPABILITIES])
            val_m = evaluate_percap(val_arr, params, mu_per_cap, bias_per_cap)
            if val_m["accuracy"] > best["val_accuracy"]:
                best["val_accuracy"] = val_m["accuracy"]
                best["params"] = dict(params)
                best["mu_per_cap"] = mu_per_cap.tolist()
                best["bias_per_cap"] = bias_per_cap.tolist()
                if wandb is not None:
                    wandb.log({"i": i, "best_val_accuracy": val_m["accuracy"]})
            if (i + 1) % (args.trials // 10 + 1) == 0:
                print(f"  [{i + 1}/{args.trials}] best_val={best['val_accuracy']:.4f}  elapsed={time.time() - t0:.1f}s")

    # HONEST EVAL on TEST
    test_m = evaluate_percap(test_arr, best["params"], np.array(best["mu_per_cap"]), np.array(best["bias_per_cap"]))
    train_m = evaluate_percap(train_arr, best["params"], np.array(best["mu_per_cap"]), np.array(best["bias_per_cap"]))

    out_dict = {
        "split": {"train": len(train), "val": len(val), "test": len(test)},
        "best_val_accuracy": best["val_accuracy"],
        "test_accuracy": test_m["accuracy"],
        "train_accuracy": train_m["accuracy"],
        "test_distribution": {m: test_m[f"model_{m}_pct"] for m in MODELS},
        "test_per_dim": {k[4:]: v for k, v in test_m.items() if k.startswith("acc_")},
        "test_avg_cost": test_m["avg_cost"],
        "best_params": best["params"],
        "best_mu_per_cap": dict(zip(BASE_CAPABILITIES, best["mu_per_cap"], strict=False)),
        "best_bias_per_cap": dict(zip(BASE_CAPABILITIES, best["bias_per_cap"], strict=False)),
        "skill_vectors": skill_vectors,
        "mode": args.mode,
        "seed": args.seed,
    }
    args.out.parent.mkdir(parents=True, exist_ok=True)
    with args.out.open("w") as f:
        json.dump(out_dict, f, indent=2)

    print(f"\n=== HONEST 3-WAY RESULTS (mode={args.mode}) ===")
    print(f"split: train={len(train)} val={len(val)} test={len(test)}")
    print(f"train_accuracy: {train_m['accuracy']:.4f}")
    print(f"val_accuracy  : {best['val_accuracy']:.4f}")
    print(f"TEST_ACCURACY : {test_m['accuracy']:.4f}  <-- HONEST")
    print(
        f"  test distribution: qwen={test_m['model_qwen_pct']:.3f} ds4={test_m['model_ds4_pct']:.3f} kimi={test_m['model_kimi_pct']:.3f}"
    )
    print(f"  test avg_cost: {test_m['avg_cost']:.4f}")
    print(f"  val/test gap : {best['val_accuracy'] - test_m['accuracy']:+.4f}")

    if wandb is not None:
        run.summary["train_accuracy"] = train_m["accuracy"]
        run.summary["val_accuracy"] = best["val_accuracy"]
        run.summary["TEST_ACCURACY"] = test_m["accuracy"]
        run.summary["val_test_gap"] = best["val_accuracy"] - test_m["accuracy"]
        run.summary["test_avg_cost"] = test_m["avg_cost"]
        for m in MODELS:
            run.summary[f"test_{m}_pct"] = test_m[f"model_{m}_pct"]
        for k, v in best["params"].items():
            if isinstance(v, int | float):
                run.summary[f"best_{k}"] = v
        wandb.finish()


if __name__ == "__main__":
    main()
