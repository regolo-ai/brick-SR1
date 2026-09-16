#!/usr/bin/env python3
"""Sweep Brick risk-adjusted routing parameters and log to W&B.

The preferred input is `run_brick_debug.py` output, which contains real Brick
capability probabilities and complexity estimates. For early diagnostics, pass
`--oracle-dimension` to use Dataset A dimensions as an oracle capability signal.
"""

from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import math
import os
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any

import numpy as np

PROJECT = "brick-risk-adjusted-routing"
ENTITY = "massa-industries"
DEBUG_INPUT = Path(os.environ.get("BRICK_BASELINE_OUTPUT", "./baseline-output")) / "brick_debug.jsonl"
COMPARISON_INPUT = Path(os.environ.get("BRICK_BASELINE_OUTPUT", "./baseline-output")) / "comparison.jsonl.gz"
OUT_JSONL = Path(os.environ.get("BRICK_BASELINE_OUTPUT", "./baseline-output")) / "brick_risk_sweep.jsonl"
PARETO_JSONL = Path(os.environ.get("BRICK_BASELINE_OUTPUT", "./baseline-output")) / "brick_risk_pareto.jsonl"

BASE_CAPABILITIES = (
    "coding",
    "creative_synthesis",
    "instruction_following",
    "math_reasoning",
    "planning_agentic",
    "world_knowledge",
)
ORACLE_CAPABILITIES = (
    "coding",
    "creative_synthesis",
    "instruction_following",
    "math_reasoning",
    "planning_agentic",
    "planning_agentic_multiturn",
    "world_knowledge",
)
MODELS = ("qwen", "ds4", "kimi")
COST = {"qwen": 0.10, "ds4": 0.40, "kimi": 0.60}
RANK = {"qwen": 0, "ds4": 1, "kimi": 2}

SKILL_VECTORS_6 = {
    "qwen": [0.714788, 0.511538, 0.810109, 0.912146, 0.577072, 0.179876],
    "ds4": [0.820939, 0.657845, 0.863112, 0.934963, 0.620550, 0.488518],
    "kimi": [0.904272, 0.751595, 0.870180, 0.943892, 0.641863, 0.344074],
}
SKILL_VECTORS_7 = {model: vec[:5] + [vec[4]] + [vec[5]] for model, vec in SKILL_VECTORS_6.items()}

DEFAULT_OVER_LAMBDA = 0.05
DEFAULT_COST_BETA = 0.10
PREFERENCE_GAMMA = math.log(1.6)
PREFERENCE_DELTA = math.log(4.0)
PREFERENCE_OMEGA = math.log(3.0)
PREFERENCE_ETA = 0.15


def logit(value: float) -> float:
    value = min(max(value, 1e-6), 1 - 1e-6)
    return math.log(value / (1 - value))


def effective_params(params: dict[str, float]) -> dict[str, float]:
    r = min(max(params["routing_preference"], -1.0), 1.0)
    mu = params["complexity_mu"] * math.exp(PREFERENCE_GAMMA * r)
    bias = params["complexity_bias"] + PREFERENCE_ETA * r
    beta = params["cost_penalty_beta"]
    if beta == 0 and r != 0:
        beta = DEFAULT_COST_BETA
    beta *= math.exp(-PREFERENCE_DELTA * r)
    lam = params["over_penalty_lambda"] * math.exp(-PREFERENCE_OMEGA * r)
    return {"mu": mu, "bias": bias, "beta": beta, "lambda": lam}


def predict(row: dict[str, Any], params: dict[str, float], skill_vectors: dict[str, list[float]]) -> str:
    eff = effective_params(params)
    tau = row["tau_query"] if row.get("tau_query") is not None else params["tau_base"]
    zq = eff["bias"] + eff["mu"] * logit(tau)
    best: tuple[float, str] | None = None
    for model in MODELS:
        under_sum = over_sum = 0.0
        for p, skill in zip(row["probabilities"], skill_vectors[model], strict=False):
            requirement = p * zq
            model_value = p * logit(skill)
            under = max(0.0, requirement - model_value)
            over = max(0.0, model_value - requirement)
            under_sum += under * under
            over_sum += over * over
        distance = math.sqrt(under_sum + eff["lambda"] * over_sum)
        score = distance + eff["beta"] * COST[model]
        item = (score, model)
        if best is None or item < best:
            best = item
    assert best is not None
    return best[1]


def prepare_arrays(rows: list[dict[str, Any]], skill_vectors: dict[str, list[float]]) -> dict[str, Any]:
    probabilities = np.asarray([row["probabilities"] for row in rows], dtype=np.float64)
    tau = np.asarray(
        [np.nan if row.get("tau_query") is None else float(row["tau_query"]) for row in rows], dtype=np.float64
    )
    gt = np.asarray([RANK[row["ground_truth"]] for row in rows], dtype=np.int64)
    dims = np.asarray([row["dimension"] for row in rows], dtype=object)
    model_logits = np.asarray([[logit(skill) for skill in skill_vectors[model]] for model in MODELS], dtype=np.float64)
    model_values = probabilities[None, :, :] * model_logits[:, None, :]
    return {
        "probabilities": probabilities,
        "tau": tau,
        "gt": gt,
        "dims": dims,
        "model_values": model_values,
        "costs": np.asarray([COST[model] for model in MODELS], dtype=np.float64),
    }


def load_jsonl(path: Path) -> list[dict[str, Any]]:
    with path.open() as f:
        return [json.loads(line) for line in f if line.strip()]


def load_comparison(path: Path) -> list[dict[str, Any]]:
    with gzip.open(path, "rt") as f:
        return [json.loads(line) for line in f if line.strip()]


def rows_from_debug(
    path: Path, comparison_path: Path
) -> tuple[list[dict[str, Any]], tuple[str, ...], dict[str, list[float]]]:
    comparison = {row["query_id"]: row for row in load_comparison(comparison_path)}
    out = []
    for row in load_jsonl(path):
        debug = row.get("brick_debug")
        if not isinstance(debug, dict) or "_parse_error" in debug:
            continue
        capability = debug.get("capability")
        if not isinstance(capability, dict):
            continue
        comp = comparison.get(row["query_id"], {})
        probs = [float(capability.get(cap, 0.0) or 0.0) for cap in BASE_CAPABILITIES]
        total = sum(max(0.0, p) for p in probs)
        if total <= 0:
            continue
        probs = [max(0.0, p) / total for p in probs]
        out.append(
            {
                "query_id": row["query_id"],
                "dimension": row.get("dimension") or comp.get("dimension"),
                "ground_truth": row.get("ground_truth") or comp.get("ground_truth"),
                "probabilities": probs,
                "tau_query": row.get("brick_tau_query")
                if row.get("brick_tau_query") is not None
                else debug.get("tau_query"),
            }
        )
    return out, BASE_CAPABILITIES, SKILL_VECTORS_6


def rows_from_oracle_dimension(path: Path) -> tuple[list[dict[str, Any]], tuple[str, ...], dict[str, list[float]]]:
    out = []
    cap_index = {cap: i for i, cap in enumerate(ORACLE_CAPABILITIES)}
    for row in load_comparison(path):
        probs = [0.0] * len(ORACLE_CAPABILITIES)
        probs[cap_index[row["dimension"]]] = 1.0
        out.append(
            {
                "query_id": row["query_id"],
                "dimension": row["dimension"],
                "ground_truth": row["ground_truth"],
                "probabilities": probs,
                "tau_query": None,
            }
        )
    return out, ORACLE_CAPABILITIES, SKILL_VECTORS_7


def split_rows(
    rows: list[dict[str, Any]], dev_fraction: float, seed: str
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    by_dim: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in rows:
        by_dim[row["dimension"]].append(row)
    dev: list[dict[str, Any]] = []
    holdout: list[dict[str, Any]] = []
    for dim_rows in by_dim.values():
        ordered = sorted(
            dim_rows,
            key=lambda row: hashlib.sha256(f"{seed}:{row['query_id']}".encode()).hexdigest(),
        )
        n_dev = int(round(len(ordered) * dev_fraction))
        dev.extend(ordered[:n_dev])
        holdout.extend(ordered[n_dev:])
    return dev, holdout


def evaluate(
    rows: list[dict[str, Any]], params: dict[str, float], skill_vectors: dict[str, list[float]]
) -> dict[str, Any]:
    counts = Counter()
    dim_hits = Counter()
    dim_total = Counter()
    cost_total = 0.0
    hits = over = under = 0
    for row in rows:
        pred = predict(row, params, skill_vectors)
        gt = row["ground_truth"]
        counts[pred] += 1
        cost_total += COST[pred]
        hit = pred == gt
        hits += hit
        dim_total[row["dimension"]] += 1
        dim_hits[row["dimension"]] += hit
        if pred != gt:
            if RANK[pred] > RANK[gt]:
                over += 1
            else:
                under += 1
    n = max(len(rows), 1)
    metrics: dict[str, Any] = {
        "accuracy": hits / n,
        "avg_cost": cost_total / n,
        "cost_per_correct": (cost_total / n) / max(hits / n, 1e-12),
        "over_route_rate": over / n,
        "under_route_rate": under / n,
    }
    for model in MODELS:
        metrics[f"model_{model}_pct"] = counts[model] / n
    for dim, total in dim_total.items():
        metrics[f"acc_{dim}"] = dim_hits[dim] / total
    return metrics


def evaluate_prepared(data: dict[str, Any], params: dict[str, float]) -> dict[str, Any]:
    eff = effective_params(params)
    tau = np.where(np.isnan(data["tau"]), params["tau_base"], data["tau"])
    zq = eff["bias"] + eff["mu"] * np.log(np.clip(tau, 1e-6, 1 - 1e-6) / np.clip(1 - tau, 1e-6, 1))
    requirement = data["probabilities"] * zq[:, None]
    under = np.maximum(0.0, requirement[None, :, :] - data["model_values"])
    over = np.maximum(0.0, data["model_values"] - requirement[None, :, :])
    distance = np.sqrt(np.sum(under * under + eff["lambda"] * over * over, axis=2))
    score = distance + eff["beta"] * data["costs"][:, None]
    pred = np.argmin(score, axis=0)

    gt = data["gt"]
    hits = pred == gt
    n = max(len(gt), 1)
    avg_cost = float(np.mean(data["costs"][pred]))
    metrics: dict[str, Any] = {
        "accuracy": float(np.mean(hits)),
        "avg_cost": avg_cost,
        "cost_per_correct": avg_cost / max(float(np.mean(hits)), 1e-12),
        "over_route_rate": float(np.mean(pred > gt)),
        "under_route_rate": float(np.mean(pred < gt)),
    }
    for i, model in enumerate(MODELS):
        metrics[f"model_{model}_pct"] = float(np.sum(pred == i) / n)
    for dim in sorted(set(data["dims"])):
        mask = data["dims"] == dim
        metrics[f"acc_{dim}"] = float(np.mean(hits[mask]))
    return metrics


def grid_values(quick: bool, has_raw_tau: bool) -> list[dict[str, float]]:
    grid = {
        "routing_preference": [-1.0, -0.5, 0.0, 0.5, 1.0]
        if quick
        else [-1.0, -0.75, -0.5, -0.25, 0.0, 0.25, 0.5, 0.75, 1.0],
        "complexity_mu": [0.4, 0.7, 1.0, 1.4] if quick else [0.25, 0.40, 0.55, 0.70, 0.85, 1.00, 1.25, 1.60],
        "complexity_bias": [-0.6, 0.0, 0.6] if quick else [-1.00, -0.60, -0.30, 0.00, 0.30, 0.60, 1.00],
        "cost_penalty_beta": [0.0, 0.1, 0.4] if quick else [0.00, 0.02, 0.05, 0.10, 0.20, 0.40, 0.80],
        "over_penalty_lambda": [0.02, 0.10, 0.50] if quick else [0.00, 0.02, 0.05, 0.10, 0.20, 0.50, 1.00, 2.00],
        "tau_base": [0.72] if has_raw_tau else ([0.55, 0.72, 0.88] if quick else [0.55, 0.62, 0.72, 0.80, 0.88]),
    }
    keys = list(grid)
    values = [[]]
    for key in keys:
        values = [prefix + [value] for prefix in values for value in grid[key]]
    return [dict(zip(keys, value, strict=False)) for value in values]


def mark_pareto(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    ordered = sorted(rows, key=lambda row: (row["holdout_avg_cost"], -row["holdout_accuracy"]))
    best_acc = -1.0
    pareto = []
    for row in ordered:
        if row["holdout_accuracy"] > best_acc + 1e-12:
            row["is_pareto"] = True
            pareto.append(row)
            best_acc = row["holdout_accuracy"]
        else:
            row["is_pareto"] = False
    return pareto


def setup_wandb(args: argparse.Namespace):
    if args.wandb_mode == "disabled":
        return None, None
    os.environ["WANDB_MODE"] = args.wandb_mode
    if args.wandb_mode == "online" and not os.environ.get("WANDB_API_KEY"):
        key_path = Path.home() / ".wandb_key"
        if key_path.exists():
            os.environ["WANDB_API_KEY"] = key_path.read_text().strip()
    import wandb  # type: ignore

    run = wandb.init(
        entity=args.entity,
        project=args.project,
        job_type="risk_sweep",
        config={
            "input": str(args.input),
            "comparison": str(args.comparison),
            "oracle_dimension": args.oracle_dimension,
            "quick": args.quick,
            "dev_fraction": args.dev_fraction,
            "seed": args.seed,
        },
    )
    return wandb, run


def log_wandb_tables(
    wandb: Any, results: list[dict[str, Any]], pareto: list[dict[str, Any]], out: Path, pareto_out: Path
) -> None:
    scalar_keys = sorted(
        {key for row in results for key, value in row.items() if isinstance(value, int | float | bool | str)}
    )
    table = wandb.Table(columns=scalar_keys)
    for row in results:
        table.add_data(*(row.get(key) for key in scalar_keys))
    pareto_table = wandb.Table(columns=scalar_keys)
    for row in pareto:
        pareto_table.add_data(*(row.get(key) for key in scalar_keys))
    wandb.log({"sweep_results": table, "pareto_frontier": pareto_table})

    artifact = wandb.Artifact("brick_risk_sweep_results", type="dataset")
    artifact.add_file(str(out))
    artifact.add_file(str(pareto_out))
    wandb.log_artifact(artifact)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", type=Path, default=DEBUG_INPUT)
    parser.add_argument("--comparison", type=Path, default=COMPARISON_INPUT)
    parser.add_argument("--out", type=Path, default=OUT_JSONL)
    parser.add_argument("--pareto-out", type=Path, default=PARETO_JSONL)
    parser.add_argument("--oracle-dimension", action="store_true")
    parser.add_argument("--quick", action="store_true")
    parser.add_argument("--dev-fraction", type=float, default=0.70)
    parser.add_argument("--seed", default="brick-risk-v1")
    parser.add_argument("--wandb-mode", choices=["disabled", "offline", "online"], default="offline")
    parser.add_argument("--entity", default=ENTITY)
    parser.add_argument("--project", default=PROJECT)
    args = parser.parse_args()

    if args.oracle_dimension:
        rows, capabilities, skill_vectors = rows_from_oracle_dimension(args.comparison)
    else:
        if not args.input.exists():
            raise SystemExit(f"debug replay not found: {args.input}; run run_brick_debug.py or pass --oracle-dimension")
        rows, capabilities, skill_vectors = rows_from_debug(args.input, args.comparison)
    if not rows:
        raise SystemExit("no usable rows loaded")

    dev, holdout = split_rows(rows, args.dev_fraction, args.seed)
    has_raw_tau = all(row.get("tau_query") is not None for row in rows)
    combos = grid_values(args.quick, has_raw_tau)
    dev_arrays = prepare_arrays(dev, skill_vectors)
    holdout_arrays = prepare_arrays(holdout, skill_vectors)

    results = []
    for params in combos:
        dev_metrics = evaluate_prepared(dev_arrays, params)
        holdout_metrics = evaluate_prepared(holdout_arrays, params)
        row = dict(params)
        row.update({f"dev_{k}": v for k, v in dev_metrics.items()})
        row.update({f"holdout_{k}": v for k, v in holdout_metrics.items()})
        row["n_rows"] = len(rows)
        row["n_dev"] = len(dev)
        row["n_holdout"] = len(holdout)
        row["capability_mode"] = "oracle_dimension" if args.oracle_dimension else "brick_debug"
        row["capabilities"] = ",".join(capabilities)
        results.append(row)

    pareto = mark_pareto(results)
    results.sort(key=lambda row: (not row["is_pareto"], -row["holdout_accuracy"], row["holdout_avg_cost"]))

    args.out.parent.mkdir(parents=True, exist_ok=True)
    with args.out.open("w") as f:
        for row in results:
            f.write(json.dumps(row, sort_keys=True) + "\n")
    with args.pareto_out.open("w") as f:
        for row in pareto:
            f.write(json.dumps(row, sort_keys=True) + "\n")

    best = max(results, key=lambda row: (row["holdout_accuracy"], -row["holdout_avg_cost"]))
    print(f"loaded rows={len(rows)} dev={len(dev)} holdout={len(holdout)} combos={len(combos)}")
    print(f"best holdout accuracy={best['holdout_accuracy']:.4f} avg_cost={best['holdout_avg_cost']:.4f}")
    print(f"wrote {args.out} and {args.pareto_out}")

    wandb, run = setup_wandb(args)
    if wandb is not None:
        run.summary["best_holdout_accuracy"] = best["holdout_accuracy"]
        run.summary["best_holdout_avg_cost"] = best["holdout_avg_cost"]
        run.summary["pareto_points"] = len(pareto)
        log_wandb_tables(wandb, results, pareto, args.out, args.pareto_out)
        wandb.finish()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
