#!/usr/bin/env python3
"""Evaluate the locked aggressive Brick knob on the full Dataset A.

This script intentionally does not tune routing hyperparameters. It reports two
views that should be kept separate in paper text:

* post_fit_full: skill vectors calibrated on all rows, evaluated on all rows.
  Useful as a descriptive/deployment number, but it leaks calibration labels.
* out_of_fold: stratified K-fold evaluation. Each row is evaluated with skill
  vectors calibrated on the other folds. This uses the whole dataset while
  avoiding per-row skill-vector leakage.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import sys
from collections import defaultdict
from pathlib import Path
from typing import Any

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from sweep_brick_v2_wandb import (  # type: ignore
    COMPARISON_INPUT,
    COST,
    DEBUG_INPUT,
    MODELS,
    RANK,
    calibrate_skills,
    rows_from_debug,
)
from sweep_knob_aggressive import (  # type: ignore
    KNOBS,
    effective_knob_params,
    prepare_knob_arrays,
)

DEFAULT_PARAMS: dict[str, float] = {
    "complexity_mu": 1.07,
    "complexity_bias": 0.15,
    "cost_penalty_beta": 0.63,
    "over_penalty_lambda": 0.35,
    "tau_base": 0.72,
    "preference_power": 1.56,
    "max_mu_multiplier": 3.24,
    "max_bias_shift": 1.05,
    "max_cost_relief": 13.4,
    "max_over_relief": 896.0,
    "min_mu_multiplier": 0.377,
    "min_bias_shift": -5.87,
    "min_cost_boost": 13.0,
    "min_over_boost": 11.9,
}

DEFAULT_OUT = Path(os.environ.get("BRICK_BASELINE_OUTPUT", "./baseline-output")) / "brick_knob_full_dataset.json"


def stratified_folds(rows: list[dict[str, Any]], k: int, seed: str) -> list[list[dict[str, Any]]]:
    folds: list[list[dict[str, Any]]] = [[] for _ in range(k)]
    by_dim: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in rows:
        by_dim[row["dimension"]].append(row)
    for dim_rows in by_dim.values():
        ordered = sorted(
            dim_rows,
            key=lambda row: hashlib.sha256(f"{seed}:{row['query_id']}".encode()).hexdigest(),
        )
        for i, row in enumerate(ordered):
            folds[i % k].append(row)
    return folds


def predict_knob(data: dict[str, Any], params: dict[str, float], preference: float) -> dict[str, Any]:
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
    selected_correct = data["correct"][np.arange(len(pred)), pred]
    route_exact = pred == data["gt"]
    return {
        "pred": pred,
        "selected_correct": selected_correct,
        "route_exact": route_exact,
        "cost": data["costs"][pred],
        "dims": data["dims"],
        "gt": data["gt"],
    }


def ci95_binary(values: np.ndarray) -> float:
    n = len(values)
    if n == 0:
        return 0.0
    p = float(np.mean(values))
    return 1.96 * math.sqrt(max(p * (1.0 - p), 0.0) / n)


def summarize_prediction(prediction: dict[str, Any]) -> dict[str, Any]:
    pred = prediction["pred"]
    selected_correct = prediction["selected_correct"].astype(bool)
    route_exact = prediction["route_exact"].astype(bool)
    cost = prediction["cost"]
    dims = prediction["dims"]
    gt = prediction["gt"]
    n = max(len(pred), 1)

    answer_acc = float(np.mean(selected_correct))
    exact_acc = float(np.mean(route_exact))
    avg_cost = float(np.mean(cost))
    out: dict[str, Any] = {
        "n": int(len(pred)),
        "selected_answer_accuracy": answer_acc,
        "selected_answer_accuracy_ci95": ci95_binary(selected_correct),
        "route_exact_accuracy": exact_acc,
        "route_exact_accuracy_ci95": ci95_binary(route_exact),
        "avg_cost": avg_cost,
        "cost_per_answer_correct": avg_cost / max(answer_acc, 1e-12),
        "over_route_rate": float(np.mean(pred > gt)),
        "under_route_rate": float(np.mean(pred < gt)),
    }
    for i, model in enumerate(MODELS):
        out[f"model_{model}_pct"] = float(np.sum(pred == i) / n)
    for dim in sorted(set(dims)):
        mask = dims == dim
        if np.any(mask):
            out[f"answer_acc_{dim}"] = float(np.mean(selected_correct[mask]))
            out[f"route_exact_acc_{dim}"] = float(np.mean(route_exact[mask]))
    return out


def concat_predictions(parts: list[dict[str, Any]]) -> dict[str, Any]:
    return {
        "pred": np.concatenate([part["pred"] for part in parts]),
        "selected_correct": np.concatenate([part["selected_correct"] for part in parts]),
        "route_exact": np.concatenate([part["route_exact"] for part in parts]),
        "cost": np.concatenate([part["cost"] for part in parts]),
        "dims": np.concatenate([part["dims"] for part in parts]),
        "gt": np.concatenate([part["gt"] for part in parts]),
    }


def evaluate_post_fit(rows: list[dict[str, Any]], params: dict[str, float]) -> dict[str, Any]:
    skills = calibrate_skills(rows)
    data = prepare_knob_arrays(rows, skills)
    return {str(knob): summarize_prediction(predict_knob(data, params, knob)) for knob in KNOBS}


def evaluate_out_of_fold(rows: list[dict[str, Any]], params: dict[str, float], folds: int, seed: str) -> dict[str, Any]:
    split = stratified_folds(rows, folds, seed)
    by_knob: dict[float, list[dict[str, Any]]] = {knob: [] for knob in KNOBS}
    fold_metrics = []
    for fold_idx, test_rows in enumerate(split):
        train_rows = [row for i, fold in enumerate(split) if i != fold_idx for row in fold]
        skills = calibrate_skills(train_rows)
        data = prepare_knob_arrays(test_rows, skills)
        fold_out: dict[str, Any] = {
            "fold": fold_idx,
            "train": len(train_rows),
            "test": len(test_rows),
            "metrics": {},
        }
        for knob in KNOBS:
            pred = predict_knob(data, params, knob)
            by_knob[knob].append(pred)
            fold_out["metrics"][str(knob)] = summarize_prediction(pred)
        fold_metrics.append(fold_out)
        print(f"[fold {fold_idx + 1}/{folds}] train={len(train_rows)} test={len(test_rows)}")

    return {
        "metrics": {str(knob): summarize_prediction(concat_predictions(parts)) for knob, parts in by_knob.items()},
        "folds": fold_metrics,
    }


def evaluate_baselines(rows: list[dict[str, Any]]) -> dict[str, Any]:
    out = {}
    gt = np.asarray([RANK[row["ground_truth"]] for row in rows], dtype=np.int64)
    dims = np.asarray([row["dimension"] for row in rows], dtype=object)
    for model_idx, model in enumerate(MODELS):
        pred = np.full(len(rows), model_idx, dtype=np.int64)
        selected_correct = np.asarray([bool(row[f"gt_{model}_correct"]) for row in rows], dtype=bool)
        route_exact = pred == gt
        out[f"always_{model}"] = summarize_prediction(
            {
                "pred": pred,
                "selected_correct": selected_correct,
                "route_exact": route_exact,
                "cost": np.full(len(rows), COST[model], dtype=np.float64),
                "dims": dims,
                "gt": gt,
            }
        )
    any_correct = np.asarray(
        [bool(row["gt_qwen_correct"] or row["gt_ds4_correct"] or row["gt_kimi_correct"]) for row in rows], dtype=bool
    )
    out["oracle_any_correct"] = {
        "n": len(rows),
        "selected_answer_accuracy": float(np.mean(any_correct)),
        "selected_answer_accuracy_ci95": ci95_binary(any_correct),
    }
    return out


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
        group="knob-full-dataset-v1",
        name=args.run_name or f"knob-full-dataset-{args.seed}",
        job_type="locked_knob_full_dataset_eval",
        tags=["knob", "full_dataset", "out_of_fold", "locked_config"],
        config={
            "seed": args.seed,
            "folds": args.folds,
            "input": str(args.input),
            "comparison": str(args.comparison),
            **{f"locked_{key}": value for key, value in DEFAULT_PARAMS.items()},
        },
    )
    return wandb, run


def print_curve(title: str, metrics: dict[str, Any]) -> None:
    print(f"\n=== {title} ===")
    for knob in KNOBS:
        m = metrics[str(knob)]
        print(
            f"{knob:+.1f}: answer={m['selected_answer_accuracy']:.4f}"
            f"±{m['selected_answer_accuracy_ci95']:.4f} "
            f"exact={m['route_exact_accuracy']:.4f} "
            f"cost={m['avg_cost']:.4f} "
            f"dist={m['model_qwen_pct']:.2f}/{m['model_ds4_pct']:.2f}/{m['model_kimi_pct']:.2f}"
        )


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", type=Path, default=DEBUG_INPUT)
    parser.add_argument("--comparison", type=Path, default=COMPARISON_INPUT)
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    parser.add_argument("--folds", type=int, default=5)
    parser.add_argument("--seed", default="knob-full-dataset")
    parser.add_argument("--wandb-mode", choices=["disabled", "offline", "online"], default="online")
    parser.add_argument("--run-name", default=None)
    parser.add_argument("--entity", default="massa-industries")
    parser.add_argument("--project", default="brick-risk-adjusted-routing")
    args = parser.parse_args()

    rows = rows_from_debug(args.input, args.comparison)
    print(f"[load] rows={len(rows)}")
    wandb_mod, run = setup_wandb(args)

    post_fit = evaluate_post_fit(rows, DEFAULT_PARAMS)
    out_of_fold = evaluate_out_of_fold(rows, DEFAULT_PARAMS, args.folds, args.seed)
    baselines = evaluate_baselines(rows)

    output = {
        "seed": args.seed,
        "folds": args.folds,
        "n": len(rows),
        "locked_params": DEFAULT_PARAMS,
        "methodology": {
            "post_fit_full": "skill vectors calibrated on all rows and evaluated on all rows; descriptive, label-leaking",
            "out_of_fold": "stratified K-fold; every row evaluated with skill vectors calibrated on other folds; hyperparameters are locked from prior development",
        },
        "post_fit_full": post_fit,
        "out_of_fold": out_of_fold["metrics"],
        "out_of_fold_folds": out_of_fold["folds"],
        "baselines": baselines,
        "wandb_url": run.url if run is not None else None,
    }
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(output, indent=2, sort_keys=True) + "\n")

    print_curve("POST-FIT FULL DATASET", post_fit)
    print_curve("OUT-OF-FOLD FULL DATASET", out_of_fold["metrics"])
    print("\n=== BASELINES FULL DATASET ===")
    for name, metrics in baselines.items():
        if not name.startswith("always_"):
            continue
        print(
            f"{name}: answer={metrics['selected_answer_accuracy']:.4f}"
            f"±{metrics['selected_answer_accuracy_ci95']:.4f} "
            f"exact={metrics['route_exact_accuracy']:.4f} cost={metrics['avg_cost']:.4f}"
        )
    print(
        "oracle_any_correct: "
        f"answer={baselines['oracle_any_correct']['selected_answer_accuracy']:.4f}"
        f"±{baselines['oracle_any_correct']['selected_answer_accuracy_ci95']:.4f}"
    )
    print(f"wrote {args.out}")

    if wandb_mod is not None:
        table = wandb_mod.Table(columns=["evaluation", "knob", "metric", "value"])
        for evaluation, curve in (("post_fit_full", post_fit), ("out_of_fold", out_of_fold["metrics"])):
            for knob, metrics in curve.items():
                for key, value in metrics.items():
                    if isinstance(value, int | float):
                        table.add_data(evaluation, float(knob), key, value)
                        run.summary[f"{evaluation}_{knob}_{key}"] = value
        for name, metrics in baselines.items():
            for key, value in metrics.items():
                if isinstance(value, int | float):
                    run.summary[f"baseline_{name}_{key}"] = value
        wandb_mod.log({"full_dataset_curve": table})
        artifact = wandb_mod.Artifact(f"brick_knob_full_dataset_{args.seed}", type="dataset")
        artifact.add_file(str(args.out))
        wandb_mod.log_artifact(artifact)
        wandb_mod.finish()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
