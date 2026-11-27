#!/usr/bin/env python3
"""Sweep an aggressive Brick routing-preference knob.

The legacy routing metric optimizes for the cheapest correct model. That is the
right target for an economy router, but it hides the purpose of a "max quality"
knob because selecting a stronger-but-more-expensive correct model is counted as
wrong. This sweep therefore tracks both:

* selected_answer_accuracy: selected model answered correctly.
* route_exact_accuracy: selected model is the cheapest correct ground-truth tier.
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
from typing import Any

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from eval_brick_3way import split_3way  # type: ignore
from sweep_brick_v2_wandb import (  # type: ignore
    COMPARISON_INPUT,
    DEBUG_INPUT,
    MODELS,
    calibrate_skills,
    rows_from_debug,
)
from sweep_brick_v3_percap import prepare_arrays  # type: ignore

DEFAULT_OUT = Path(os.environ.get("BRICK_BASELINE_OUTPUT", "./baseline-output")) / "brick_knob_aggressive.json"
KNOBS = (-1.0, -0.5, 0.0, 0.5, 1.0)


def prepare_knob_arrays(rows: list[dict[str, Any]], skill_vectors: dict[str, list[float]]) -> dict[str, Any]:
    data = prepare_arrays(rows, skill_vectors)
    data["correct"] = np.asarray(
        [[bool(row[f"gt_{model}_correct"]) for model in MODELS] for row in rows],
        dtype=bool,
    )
    return data


def positive_or_default(value: float | None, default: float) -> float:
    if value is None or value <= 0 or not math.isfinite(value):
        return default
    return value


def effective_knob_params(params: dict[str, float], preference: float) -> dict[str, float]:
    r = max(-1.0, min(1.0, preference))
    power = positive_or_default(params.get("preference_power"), 1.0)
    pos = max(r, 0.0) ** power
    neg = max(-r, 0.0) ** power
    return {
        "complexity_mu": params["complexity_mu"]
        * math.exp(pos * math.log(params["max_mu_multiplier"]) + neg * math.log(params["min_mu_multiplier"])),
        "complexity_bias": params["complexity_bias"] + pos * params["max_bias_shift"] + neg * params["min_bias_shift"],
        "cost_penalty_beta": params["cost_penalty_beta"]
        * math.exp(-pos * math.log(params["max_cost_relief"]) + neg * math.log(params["min_cost_boost"])),
        "over_penalty_lambda": params["over_penalty_lambda"]
        * math.exp(-pos * math.log(params["max_over_relief"]) + neg * math.log(params["min_over_boost"])),
    }


def evaluate_knob(data: dict[str, Any], params: dict[str, float], preference: float) -> dict[str, Any]:
    eff = effective_knob_params(params, preference)
    raw_tau = data["tau"]
    tau_q = np.where(np.isnan(raw_tau), params["tau_base"], raw_tau)
    log_tau = np.log(np.clip(tau_q, 1e-6, 1 - 1e-6) / np.clip(1 - tau_q, 1e-6, 1))
    requirement = data["probabilities"] * (eff["complexity_bias"] + eff["complexity_mu"] * log_tau)[:, None]

    under = np.maximum(0.0, requirement[None, :, :] - data["model_values"])
    over = np.maximum(0.0, data["model_values"] - requirement[None, :, :])
    distance = np.sqrt(np.sum(under * under + eff["over_penalty_lambda"] * over * over, axis=2))
    score = distance + eff["cost_penalty_beta"] * data["costs"][:, None]
    pred = np.argmin(score, axis=0)

    n = max(len(pred), 1)
    selected_correct = data["correct"][np.arange(len(pred)), pred]
    out = {
        "selected_answer_accuracy": float(np.mean(selected_correct)),
        "route_exact_accuracy": float(np.mean(pred == data["gt"])),
        "avg_cost": float(np.mean(data["costs"][pred])),
        "cost_per_answer_correct": float(np.mean(data["costs"][pred]) / max(np.mean(selected_correct), 1e-12)),
        "over_route_rate": float(np.mean(pred > data["gt"])),
        "under_route_rate": float(np.mean(pred < data["gt"])),
        **{f"effective_{key}": value for key, value in eff.items()},
    }
    for i, model in enumerate(MODELS):
        out[f"model_{model}_pct"] = float(np.sum(pred == i) / n)
    for dim in sorted(set(data["dims"])):
        mask = data["dims"] == dim
        if np.any(mask):
            out[f"answer_acc_{dim}"] = float(np.mean(selected_correct[mask]))
            out[f"route_exact_acc_{dim}"] = float(np.mean((pred == data["gt"])[mask]))
    return out


def sample_params(rnd: random.Random) -> dict[str, float]:
    return {
        "complexity_mu": math.exp(rnd.uniform(math.log(0.05), math.log(2.0))),
        "complexity_bias": rnd.uniform(-1.5, 1.5),
        "cost_penalty_beta": math.exp(rnd.uniform(math.log(0.005), math.log(2.0))),
        "over_penalty_lambda": math.exp(rnd.uniform(math.log(0.002), math.log(2.0))),
        "tau_base": rnd.uniform(0.30, 0.90),
        "preference_power": rnd.uniform(1.0, 3.5),
        "max_mu_multiplier": math.exp(rnd.uniform(math.log(1.5), math.log(30.0))),
        "max_bias_shift": rnd.uniform(0.2, 6.0),
        "max_cost_relief": math.exp(rnd.uniform(math.log(10.0), math.log(10000.0))),
        "max_over_relief": math.exp(rnd.uniform(math.log(10.0), math.log(10000.0))),
        "min_mu_multiplier": math.exp(rnd.uniform(math.log(0.01), math.log(0.70))),
        "min_bias_shift": rnd.uniform(-6.0, -0.2),
        "min_cost_boost": math.exp(rnd.uniform(math.log(2.0), math.log(100.0))),
        "min_over_boost": math.exp(rnd.uniform(math.log(2.0), math.log(100.0))),
    }


def objective(metrics: dict[float, dict[str, Any]]) -> float:
    eco = metrics[-1.0]
    neutral = metrics[0.0]
    max_quality = metrics[1.0]
    strong_max = max_quality["model_ds4_pct"] + max_quality["model_kimi_pct"]

    penalty = 0.0
    penalty += max(0.0, eco["avg_cost"] - 0.115) * 20.0
    penalty += max(0.0, 0.95 - eco["model_qwen_pct"]) * 2.0
    penalty += max(0.0, 0.70 - strong_max) * 1.5
    penalty += max(0.0, neutral["avg_cost"] - 0.25) * 5.0
    penalty += max(0.0, 0.13 - neutral["avg_cost"]) * 2.0
    penalty += max(0.0, eco["avg_cost"] - neutral["avg_cost"]) * 10.0
    penalty += max(0.0, neutral["avg_cost"] - max_quality["avg_cost"]) * 3.0

    return (
        6.0 * max_quality["selected_answer_accuracy"]
        + 1.5 * neutral["selected_answer_accuracy"]
        + 0.5 * strong_max
        - 0.6 * neutral["avg_cost"]
        - 0.2 * eco["avg_cost"]
        - penalty
    )


def setup_wandb(args: argparse.Namespace):
    if args.wandb_mode == "disabled":
        return None, None
    os.environ["WANDB_MODE"] = args.wandb_mode
    if args.wandb_mode == "online" and not os.environ.get("WANDB_API_KEY"):
        key_path = Path.home() / ".wandb_key"
        if key_path.exists():
            os.environ["WANDB_API_KEY"] = key_path.read_text().strip()
    import wandb

    run = wandb.init(
        entity=args.entity,
        project=args.project,
        group="knob-aggressive-v1",
        name=args.run_name or f"knob-aggressive-{args.seed}",
        job_type="knob_aggressive_sweep",
        tags=["knob", "aggressive", "selected_answer_accuracy"],
        config={
            "seed": args.seed,
            "trials": args.trials,
            "input": str(args.input),
            "train_frac": args.train_frac,
            "val_frac": args.val_frac,
        },
    )
    return wandb, run


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", type=Path, default=DEBUG_INPUT)
    parser.add_argument("--comparison", type=Path, default=COMPARISON_INPUT)
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    parser.add_argument("--trials", type=int, default=50000)
    parser.add_argument("--seed", default="knob-aggressive")
    parser.add_argument("--train-frac", type=float, default=0.60)
    parser.add_argument("--val-frac", type=float, default=0.20)
    parser.add_argument("--wandb-mode", choices=["disabled", "offline", "online"], default="online")
    parser.add_argument("--run-name", default=None)
    parser.add_argument("--entity", default="massa-industries")
    parser.add_argument("--project", default="brick-risk-adjusted-routing")
    args = parser.parse_args()

    rows = rows_from_debug(args.input, args.comparison)
    train, val, test = split_3way(rows, args.train_frac, args.val_frac, args.seed)
    print(f"[load] rows={len(rows)} train={len(train)} val={len(val)} test={len(test)}")
    skills = calibrate_skills(train)
    val_arr = prepare_knob_arrays(val, skills)
    test_arr = prepare_knob_arrays(test, skills)

    wandb_mod, run = setup_wandb(args)
    rnd = random.Random(args.seed)
    best: dict[str, Any] | None = None
    top: list[dict[str, Any]] = []
    t0 = time.time()
    log_every = max(100, args.trials // 100)

    for i in range(args.trials):
        params = sample_params(rnd)
        val_metrics = {knob: evaluate_knob(val_arr, params, knob) for knob in (-1.0, 0.0, 1.0)}
        score = objective(val_metrics)
        row = {"objective": score, "params": params, "val": val_metrics}
        if best is None or score > best["objective"]:
            best = row
            if wandb_mod is not None:
                wandb_mod.log(
                    {
                        "i": i,
                        "best_objective": score,
                        "best_val_min_cost": val_metrics[-1.0]["avg_cost"],
                        "best_val_neutral_answer_acc": val_metrics[0.0]["selected_answer_accuracy"],
                        "best_val_max_answer_acc": val_metrics[1.0]["selected_answer_accuracy"],
                        "best_val_max_strong_pct": val_metrics[1.0]["model_ds4_pct"]
                        + val_metrics[1.0]["model_kimi_pct"],
                    }
                )
        top.append(row)
        top.sort(key=lambda item: item["objective"], reverse=True)
        del top[20:]

        if wandb_mod is not None and i % log_every == 0:
            wandb_mod.log(
                {
                    "i": i,
                    "trial_objective": score,
                    "trial_val_min_cost": val_metrics[-1.0]["avg_cost"],
                    "trial_val_neutral_answer_acc": val_metrics[0.0]["selected_answer_accuracy"],
                    "trial_val_max_answer_acc": val_metrics[1.0]["selected_answer_accuracy"],
                }
            )
        if (i + 1) % (args.trials // 10 + 1) == 0:
            print(f"[{i + 1}/{args.trials}] best={best['objective']:.4f} elapsed={time.time() - t0:.1f}s")

    assert best is not None
    test_metrics = {knob: evaluate_knob(test_arr, best["params"], knob) for knob in KNOBS}
    out = {
        "seed": args.seed,
        "run_name": args.run_name,
        "wandb_url": run.url if run is not None else None,
        "split": {"train": len(train), "val": len(val), "test": len(test)},
        "objective": best["objective"],
        "best_params": best["params"],
        "val_metrics": {str(k): v for k, v in best["val"].items()},
        "test_metrics": {str(k): v for k, v in test_metrics.items()},
        "top_val": top,
        "skill_vectors": skills,
    }
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(out, indent=2, sort_keys=True) + "\n")

    print("\n=== BEST KNOB CONFIG ===")
    print(json.dumps(best["params"], indent=2, sort_keys=True))
    print("\n=== TEST CURVE ===")
    for knob in KNOBS:
        m = test_metrics[knob]
        print(
            f"{knob:+.1f}: answer={m['selected_answer_accuracy']:.4f} "
            f"exact={m['route_exact_accuracy']:.4f} cost={m['avg_cost']:.4f} "
            f"dist={m['model_qwen_pct']:.2f}/{m['model_ds4_pct']:.2f}/{m['model_kimi_pct']:.2f}"
        )
    print(f"wrote {args.out}")

    if wandb_mod is not None:
        run.summary["objective"] = best["objective"]
        for key, value in best["params"].items():
            run.summary[f"best_{key}"] = value
        for knob, metrics in test_metrics.items():
            prefix = {-1.0: "min", -0.5: "low", 0.0: "neutral", 0.5: "high", 1.0: "max"}[knob]
            for key, value in metrics.items():
                if isinstance(value, int | float):
                    run.summary[f"test_{prefix}_{key}"] = value
        table = wandb_mod.Table(columns=["knob", "metric", "value"])
        for knob, metrics in test_metrics.items():
            for key, value in metrics.items():
                if isinstance(value, int | float):
                    table.add_data(knob, key, value)
        wandb_mod.log({"test_knob_curve": table})
        artifact = wandb_mod.Artifact(f"brick_knob_aggressive_{args.seed}", type="dataset")
        artifact.add_file(str(args.out))
        wandb_mod.log_artifact(artifact)
        wandb_mod.finish()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
