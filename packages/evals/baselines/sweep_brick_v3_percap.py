#!/usr/bin/env python3
"""Sweep V3 with per-capability mu/bias vectors.

Each of 6 capabilities gets its own (mu, bias) multiplier. Random search over
this much larger space; warmstart from V2 best as the global baseline.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import random
import sys
import time
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from sweep_brick_v2_wandb import (  # type: ignore
    BASE_CAPABILITIES,
    COMPARISON_INPUT,
    COST,
    DEBUG_INPUT,
    MODELS,
    RANK,
    calibrate_skills,
    effective_params,
    logit,
    rows_from_debug,
    split_rows,
)


def prepare_arrays(rows, skill_vectors):
    probabilities = np.asarray([row["probabilities"] for row in rows], dtype=np.float64)
    tau = np.asarray(
        [np.nan if row.get("tau_query") is None else float(row["tau_query"]) for row in rows], dtype=np.float64
    )
    gt = np.asarray([RANK[row["ground_truth"]] for row in rows], dtype=np.int64)
    dims = np.asarray([row["dimension"] for row in rows], dtype=object)
    model_logits = np.asarray([[logit(s) for s in skill_vectors[m]] for m in MODELS], dtype=np.float64)
    model_values = probabilities[None, :, :] * model_logits[:, None, :]
    return {
        "probabilities": probabilities,
        "tau": tau,
        "gt": gt,
        "dims": dims,
        "model_values": model_values,
        "costs": np.asarray([COST[m] for m in MODELS], dtype=np.float64),
    }


def evaluate_percap(data, params, mu_per_cap, bias_per_cap):
    eff = effective_params(params)
    raw_tau = data["tau"]
    tau_q = np.where(np.isnan(raw_tau), params["tau_base"], raw_tau)
    log_tau = np.log(np.clip(tau_q, 1e-6, 1 - 1e-6) / np.clip(1 - tau_q, 1e-6, 1))
    zq_global = eff["bias"] + eff["mu"] * log_tau  # (N,)
    # per-cap requirement multiplier
    requirement = data["probabilities"] * (zq_global[:, None] * mu_per_cap[None, :] + bias_per_cap[None, :])
    under = np.maximum(0.0, requirement[None, :, :] - data["model_values"])
    over = np.maximum(0.0, data["model_values"] - requirement[None, :, :])
    distance = np.sqrt(np.sum(under * under + eff["lambda"] * over * over, axis=2))
    score = distance + eff["beta"] * data["costs"][:, None]
    pred = np.argmin(score, axis=0)

    gt = data["gt"]
    hits = pred == gt
    n = max(len(gt), 1)
    avg_cost = float(np.mean(data["costs"][pred]))
    acc = float(np.mean(hits))
    out = {
        "accuracy": acc,
        "avg_cost": avg_cost,
        "cost_per_correct": avg_cost / max(acc, 1e-12),
        "over_route_rate": float(np.mean(pred > gt)),
        "under_route_rate": float(np.mean(pred < gt)),
    }
    for i, m in enumerate(MODELS):
        out[f"model_{m}_pct"] = float(np.sum(pred == i) / n)
    for dim in sorted(set(data["dims"])):
        mask = data["dims"] == dim
        out[f"acc_{dim}"] = float(np.mean(hits[mask]))
    return out


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--input", type=Path, default=DEBUG_INPUT)
    p.add_argument("--comparison", type=Path, default=COMPARISON_INPUT)
    p.add_argument(
        "--out",
        type=Path,
        default=(Path(os.environ.get("BRICK_BASELINE_OUTPUT", "./baseline-output")) / "brick_v3_percap.jsonl"),
    )
    p.add_argument("--trials", type=int, default=20000)
    p.add_argument("--seed", default="brick-v3-percap")
    p.add_argument("--dev-fraction", type=float, default=0.70)
    p.add_argument("--wandb-mode", choices=["disabled", "offline", "online"], default="online")
    p.add_argument("--run-name", default="v3-percap-mu20k")
    p.add_argument("--entity", default="massa-industries")
    p.add_argument("--project", default="brick-risk-adjusted-routing")
    args = p.parse_args()

    rows = rows_from_debug(args.input, args.comparison)
    dev, holdout = split_rows(rows, args.dev_fraction, args.seed)
    skill_vectors = calibrate_skills(dev)
    dev_arr = prepare_arrays(dev, skill_vectors)
    hold_arr = prepare_arrays(holdout, skill_vectors)
    print(f"[load] rows={len(rows)} dev={len(dev)} holdout={len(holdout)}")

    if args.wandb_mode != "disabled":
        os.environ["WANDB_MODE"] = args.wandb_mode
        if args.wandb_mode == "online" and not os.environ.get("WANDB_API_KEY"):
            kp = Path.home() / ".wandb_key"
            if kp.exists():
                os.environ["WANDB_API_KEY"] = kp.read_text().strip()
        import wandb

        run = wandb.init(
            entity=args.entity,
            project=args.project,
            name=args.run_name,
            job_type="risk_sweep_v3_percap",
            tags=["v3", "per_cap_mu", "calibrated"],
            config={"trials": args.trials, "seed": args.seed},
        )
    else:
        wandb = None
        run = None

    rnd = random.Random(args.seed)
    best = {"holdout_accuracy": -1}
    results = []
    t0 = time.time()
    log_every = max(50, args.trials // 100)

    for i in range(args.trials):
        # Warmstart distribution: V2 best params
        params = {
            "routing_preference": max(-1.0, min(1.0, -0.5 + rnd.gauss(0, 0.3))),
            "complexity_mu": max(0.05, 0.25 + rnd.gauss(0, 0.30)),
            "complexity_bias": 0.30 + rnd.gauss(0, 0.40),
            "cost_penalty_beta": max(0.0, 0.02 + abs(rnd.gauss(0, 0.10))),
            "over_penalty_lambda": max(0.0, 0.20 + abs(rnd.gauss(0, 0.30))),
            "tau_base": max(0.30, min(0.97, 0.50 + rnd.gauss(0, 0.15))),
        }
        # per-cap multipliers: log-uniform around 1.0 each
        mu_per_cap = np.array([math.exp(rnd.gauss(0, 0.5)) for _ in BASE_CAPABILITIES])
        bias_per_cap = np.array([rnd.gauss(0, 0.3) for _ in BASE_CAPABILITIES])

        hold_m = evaluate_percap(hold_arr, params, mu_per_cap, bias_per_cap)
        dev_m = evaluate_percap(dev_arr, params, mu_per_cap, bias_per_cap)

        row = dict(params)
        for j, cap in enumerate(BASE_CAPABILITIES):
            row[f"mu_{cap}"] = float(mu_per_cap[j])
            row[f"bias_{cap}"] = float(bias_per_cap[j])
        row.update({f"dev_{k}": v for k, v in dev_m.items()})
        row.update({f"holdout_{k}": v for k, v in hold_m.items()})
        results.append(row)

        if hold_m["accuracy"] > best["holdout_accuracy"]:
            best = {
                "holdout_accuracy": hold_m["accuracy"],
                "params": params,
                "mu_per_cap": mu_per_cap.tolist(),
                "bias_per_cap": bias_per_cap.tolist(),
                "metrics": hold_m,
            }
            if wandb is not None:
                wandb.log(
                    {
                        "i": i,
                        "best_holdout_accuracy": hold_m["accuracy"],
                        "best_holdout_avg_cost": hold_m["avg_cost"],
                        "best_holdout_qwen_pct": hold_m["model_qwen_pct"],
                        "best_holdout_ds4_pct": hold_m["model_ds4_pct"],
                        "best_holdout_kimi_pct": hold_m["model_kimi_pct"],
                    }
                )

        if wandb is not None and i % log_every == 0:
            wandb.log(
                {
                    "i": i,
                    "trial_holdout_accuracy": hold_m["accuracy"],
                    "trial_holdout_avg_cost": hold_m["avg_cost"],
                }
            )

        if (i + 1) % (args.trials // 10 + 1) == 0:
            print(
                f"[{i + 1}/{args.trials}] best_holdout={best['holdout_accuracy']:.4f} elapsed={time.time() - t0:.1f}s"
            )

    args.out.parent.mkdir(parents=True, exist_ok=True)
    results.sort(key=lambda r: r["holdout_accuracy"], reverse=True)
    with args.out.open("w") as f:
        for r in results:
            f.write(json.dumps(r, sort_keys=True) + "\n")
    print(f"\n[done] best_holdout_accuracy={best['holdout_accuracy']:.4f}")
    print(f"  global params: {best['params']}")
    print(f"  mu_per_cap   : {[f'{x:.3f}' for x in best['mu_per_cap']]}")
    print(f"  bias_per_cap : {[f'{x:.3f}' for x in best['bias_per_cap']]}")
    print(
        f"  distribution : qwen={best['metrics']['model_qwen_pct']:.3f} ds4={best['metrics']['model_ds4_pct']:.3f} kimi={best['metrics']['model_kimi_pct']:.3f}"
    )

    if wandb is not None:
        run.summary["best_holdout_accuracy"] = best["holdout_accuracy"]
        run.summary["best_holdout_avg_cost"] = best["metrics"]["avg_cost"]
        for j, cap in enumerate(BASE_CAPABILITIES):
            run.summary[f"best_mu_{cap}"] = best["mu_per_cap"][j]
            run.summary[f"best_bias_{cap}"] = best["bias_per_cap"][j]
        for k, v in best["params"].items():
            run.summary[f"best_{k}"] = v
        wandb.finish()


if __name__ == "__main__":
    main()
