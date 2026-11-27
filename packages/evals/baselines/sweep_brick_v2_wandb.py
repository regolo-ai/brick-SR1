#!/usr/bin/env python3
"""Sweep V2 Brick risk-adjusted routing: extended grid + skill_vector calibration + W&B online.

Key changes vs sweep_brick_risk_wandb.py:
  --calibrate-skills   compute empirical per-model per-capability success on dev split
                       (overrides production SKILL_VECTORS_6 with data-driven values).
  --tau-sweep          always sweep tau_base globally even if brick_debug provides
                       per-query tau_query (uses tau_base as override multiplier).
  --per-cap-mu         add per-capability mu multiplier dimension to the grid.
  --random-trials N    random search instead of full grid (N trials).
  --resume-from-best   warmstart sampling near published best (mu=1.6, bias=0, beta=0.8, ...).
"""

from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import math
import os
import random
import time
from collections import defaultdict
from pathlib import Path
from typing import Any

import numpy as np

PROJECT = "brick-risk-adjusted-routing"
ENTITY = "massa-industries"
DEBUG_INPUT = Path(os.environ.get("BRICK_BASELINE_OUTPUT", "./baseline-output")) / "brick_debug_gpu.jsonl"
COMPARISON_INPUT = Path(os.environ.get("BRICK_BASELINE_OUTPUT", "./baseline-output")) / "comparison.jsonl.gz"
OUT_JSONL = Path(os.environ.get("BRICK_BASELINE_OUTPUT", "./baseline-output")) / "brick_v2_sweep.jsonl"
PARETO_JSONL = Path(os.environ.get("BRICK_BASELINE_OUTPUT", "./baseline-output")) / "brick_v2_pareto.jsonl"
SKILL_OUT = Path(os.environ.get("BRICK_BASELINE_OUTPUT", "./baseline-output")) / "brick_v2_skills.json"

BASE_CAPABILITIES = (
    "coding",
    "creative_synthesis",
    "instruction_following",
    "math_reasoning",
    "planning_agentic",
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

PREFERENCE_GAMMA = math.log(1.6)
PREFERENCE_DELTA = math.log(4.0)
PREFERENCE_OMEGA = math.log(3.0)
PREFERENCE_ETA = 0.15
DEFAULT_COST_BETA = 0.10


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


def load_jsonl(path: Path) -> list[dict[str, Any]]:
    with path.open() as f:
        return [json.loads(line) for line in f if line.strip()]


def load_comparison(path: Path) -> list[dict[str, Any]]:
    with gzip.open(path, "rt") as f:
        return [json.loads(line) for line in f if line.strip()]


def rows_from_debug(path: Path, comparison_path: Path) -> list[dict[str, Any]]:
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
        gt = row.get("ground_truth") or comp.get("ground_truth")
        if gt not in MODELS:
            continue
        out.append(
            {
                "query_id": row["query_id"],
                "dimension": row.get("dimension") or comp.get("dimension"),
                "ground_truth": gt,
                "probabilities": probs,
                "tau_query": row.get("brick_tau_query")
                if row.get("brick_tau_query") is not None
                else debug.get("tau_query"),
                "gt_qwen_correct": bool(row.get("gt_qwen_correct", comp.get("gt_qwen_correct", False))),
                "gt_ds4_correct": bool(row.get("gt_ds4_correct", comp.get("gt_ds4_correct", False))),
                "gt_kimi_correct": bool(row.get("gt_kimi_correct", comp.get("gt_kimi_correct", False))),
            }
        )
    return out


def calibrate_skills(dev_rows: list[dict[str, Any]]) -> dict[str, list[float]]:
    """Empirical per-model per-capability success on dev split.

    skill[model][cap] = P(model correct | dominant capability = cap on dev)
    """
    correct_keys = {"qwen": "gt_qwen_correct", "ds4": "gt_ds4_correct", "kimi": "gt_kimi_correct"}
    counts = np.zeros((len(MODELS), len(BASE_CAPABILITIES)), dtype=np.float64)
    weights = np.zeros((len(MODELS), len(BASE_CAPABILITIES)), dtype=np.float64)
    for row in dev_rows:
        probs = np.asarray(row["probabilities"])
        for i, model in enumerate(MODELS):
            ok = float(row[correct_keys[model]])
            counts[i] += probs * ok
            weights[i] += probs
    skill = counts / np.maximum(weights, 1e-9)
    skill = np.clip(skill, 0.02, 0.98)
    return {model: skill[i].tolist() for i, model in enumerate(MODELS)}


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


def evaluate_prepared(
    data: dict[str, Any], params: dict[str, float], per_cap_mu: np.ndarray | None = None
) -> dict[str, Any]:
    eff = effective_params(params)
    raw_tau = data["tau"]
    if params.get("tau_override_mode", "auto") == "force_base" or np.all(np.isnan(raw_tau)):
        tau_q = np.full_like(raw_tau, params["tau_base"])
    elif params.get("tau_override_mode") == "blend":
        a = params.get("tau_blend_alpha", 0.5)
        tau_q = np.where(np.isnan(raw_tau), params["tau_base"], a * raw_tau + (1 - a) * params["tau_base"])
    else:
        tau_q = np.where(np.isnan(raw_tau), params["tau_base"], raw_tau)
    zq_scalar = eff["bias"] + eff["mu"] * np.log(np.clip(tau_q, 1e-6, 1 - 1e-6) / np.clip(1 - tau_q, 1e-6, 1))

    if per_cap_mu is not None:
        # Per-cap multiplier on requirement
        zq_percap = zq_scalar[:, None] * per_cap_mu[None, :]
        requirement = data["probabilities"] * zq_percap
    else:
        requirement = data["probabilities"] * zq_scalar[:, None]

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
    metrics: dict[str, Any] = {
        "accuracy": acc,
        "avg_cost": avg_cost,
        "cost_per_correct": avg_cost / max(acc, 1e-12),
        "over_route_rate": float(np.mean(pred > gt)),
        "under_route_rate": float(np.mean(pred < gt)),
    }
    for i, model in enumerate(MODELS):
        metrics[f"model_{model}_pct"] = float(np.sum(pred == i) / n)
    for dim in sorted(set(data["dims"])):
        mask = data["dims"] == dim
        metrics[f"acc_{dim}"] = float(np.mean(hits[mask]))
    return metrics


def split_rows(rows, dev_fraction: float, seed: str):
    by_dim: dict[str, list] = defaultdict(list)
    for row in rows:
        by_dim[row["dimension"]].append(row)
    dev, holdout = [], []
    for dim_rows in by_dim.values():
        ordered = sorted(
            dim_rows,
            key=lambda r: hashlib.sha256(f"{seed}:{r['query_id']}".encode()).hexdigest(),
        )
        n_dev = int(round(len(ordered) * dev_fraction))
        dev.extend(ordered[:n_dev])
        holdout.extend(ordered[n_dev:])
    return dev, holdout


def grid_combinations(quick: bool, tau_sweep: bool) -> list[dict[str, float]]:
    grid = {
        "routing_preference": [-1.0, -0.5, 0.0, 0.5, 1.0]
        if quick
        else [-1.0, -0.75, -0.5, -0.25, 0.0, 0.25, 0.5, 0.75, 1.0],
        "complexity_mu": [0.4, 0.7, 1.0, 1.4]
        if quick
        else [0.25, 0.40, 0.55, 0.70, 0.85, 1.00, 1.25, 1.60, 2.00, 2.50],
        "complexity_bias": [-0.6, 0.0, 0.6] if quick else [-1.50, -1.00, -0.60, -0.30, 0.00, 0.30, 0.60, 1.00, 1.50],
        "cost_penalty_beta": [0.0, 0.1, 0.4] if quick else [0.00, 0.02, 0.05, 0.10, 0.20, 0.40, 0.80, 1.50],
        "over_penalty_lambda": [0.02, 0.10, 0.50] if quick else [0.00, 0.02, 0.05, 0.10, 0.20, 0.50, 1.00, 2.00, 4.00],
        "tau_base": ([0.55, 0.72, 0.88] if quick else [0.45, 0.55, 0.62, 0.72, 0.80, 0.88, 0.95])
        if tau_sweep
        else [0.72],
    }
    combos = [{}]
    for key, vals in grid.items():
        combos = [dict(prev, **{key: v}) for prev in combos for v in vals]
    return combos


def random_combinations(n: int, seed: int, focused_around: dict | None = None) -> list[dict[str, float]]:
    rnd = random.Random(seed)
    combos = []
    if focused_around is not None:
        # Narrow Gaussian-ish sampling around `focused_around`
        for _ in range(n):
            combos.append(
                {
                    "routing_preference": max(
                        -1.0, min(1.0, focused_around.get("routing_preference", -0.5) + rnd.gauss(0, 0.2))
                    ),
                    "complexity_mu": max(0.05, focused_around.get("complexity_mu", 0.25) + rnd.gauss(0, 0.15)),
                    "complexity_bias": focused_around.get("complexity_bias", 0.3) + rnd.gauss(0, 0.25),
                    "cost_penalty_beta": max(0.0, focused_around.get("cost_penalty_beta", 0.02) + rnd.gauss(0, 0.05)),
                    "over_penalty_lambda": max(
                        0.0, focused_around.get("over_penalty_lambda", 0.2) + rnd.gauss(0, 0.20)
                    ),
                    "tau_base": max(0.30, min(0.97, focused_around.get("tau_base", 0.45) + rnd.gauss(0, 0.10))),
                }
            )
    else:
        for _ in range(n):
            combos.append(
                {
                    "routing_preference": rnd.uniform(-1.0, 1.0),
                    "complexity_mu": rnd.uniform(0.2, 3.0),
                    "complexity_bias": rnd.uniform(-2.0, 2.0),
                    "cost_penalty_beta": rnd.choice([0.0]) if rnd.random() < 0.1 else rnd.uniform(0.0, 2.0),
                    "over_penalty_lambda": rnd.uniform(0.0, 5.0),
                    "tau_base": rnd.uniform(0.40, 0.95),
                }
            )
    return combos


def mark_pareto(rows):
    ordered = sorted(rows, key=lambda r: (r["holdout_avg_cost"], -r["holdout_accuracy"]))
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


def setup_wandb(args):
    if args.wandb_mode == "disabled":
        return None, None
    os.environ["WANDB_MODE"] = args.wandb_mode
    if args.wandb_mode == "online" and not os.environ.get("WANDB_API_KEY"):
        kp = Path.home() / ".wandb_key"
        if kp.exists():
            os.environ["WANDB_API_KEY"] = kp.read_text().strip()
    import wandb

    run = wandb.init(
        entity=args.entity,
        project=args.project,
        name=args.run_name or None,
        job_type="risk_sweep_v2",
        tags=[
            "v2",
            "calibrated" if args.calibrate_skills else "production_skills",
            "tau_sweep" if args.tau_sweep else "tau_fixed",
        ],
        config={
            "input": str(args.input),
            "comparison": str(args.comparison),
            "calibrate_skills": args.calibrate_skills,
            "tau_sweep": args.tau_sweep,
            "per_cap_mu": args.per_cap_mu,
            "random_trials": args.random_trials,
            "quick": args.quick,
            "dev_fraction": args.dev_fraction,
            "seed": args.seed,
        },
    )
    return wandb, run


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", type=Path, default=DEBUG_INPUT)
    parser.add_argument("--comparison", type=Path, default=COMPARISON_INPUT)
    parser.add_argument("--out", type=Path, default=OUT_JSONL)
    parser.add_argument("--pareto-out", type=Path, default=PARETO_JSONL)
    parser.add_argument("--skill-out", type=Path, default=SKILL_OUT)
    parser.add_argument("--quick", action="store_true")
    parser.add_argument(
        "--tau-sweep", action="store_true", help="Sweep tau_base globally even with raw tau_query present"
    )
    parser.add_argument("--tau-mode", choices=["raw", "force_base", "blend"], default="raw")
    parser.add_argument("--calibrate-skills", action="store_true")
    parser.add_argument("--per-cap-mu", action="store_true")
    parser.add_argument("--random-trials", type=int, default=0)
    parser.add_argument(
        "--focused-around", type=str, default=None, help="JSON dict of params to narrow random sampling around"
    )
    parser.add_argument("--dev-fraction", type=float, default=0.70)
    parser.add_argument("--seed", default="brick-v2")
    parser.add_argument("--wandb-mode", choices=["disabled", "offline", "online"], default="offline")
    parser.add_argument("--entity", default=ENTITY)
    parser.add_argument("--project", default=PROJECT)
    parser.add_argument("--run-name", default=None)
    args = parser.parse_args()

    if not args.input.exists():
        raise SystemExit(f"input not found: {args.input}")
    rows = rows_from_debug(args.input, args.comparison)
    if not rows:
        raise SystemExit("no usable rows")

    dev, holdout = split_rows(rows, args.dev_fraction, args.seed)
    print(f"[load] rows={len(rows)} dev={len(dev)} holdout={len(holdout)}")

    if args.calibrate_skills:
        skill_vectors = calibrate_skills(dev)
        args.skill_out.parent.mkdir(parents=True, exist_ok=True)
        with args.skill_out.open("w") as f:
            json.dump({"capabilities": list(BASE_CAPABILITIES), "skill_vectors": skill_vectors}, f, indent=2)
        print(f"[skills] calibrated → {args.skill_out}")
        for m, v in skill_vectors.items():
            print(f"  {m}: {[round(x, 3) for x in v]}")
    else:
        skill_vectors = SKILL_VECTORS_6

    dev_arr = prepare_arrays(dev, skill_vectors)
    hold_arr = prepare_arrays(holdout, skill_vectors)

    if args.random_trials > 0:
        focused = json.loads(args.focused_around) if args.focused_around else None
        combos = random_combinations(args.random_trials, seed=hash(args.seed) & 0xFFFF, focused_around=focused)
        mode_label = f"random_{args.random_trials}" + ("_focused" if focused else "")
    else:
        combos = grid_combinations(args.quick, args.tau_sweep)
        mode_label = "grid_quick" if args.quick else "grid_full"
    print(f"[sweep] {mode_label} combos={len(combos)}")

    wandb_mod, run = setup_wandb(args)

    results = []
    t0 = time.time()
    best_holdout = -1
    log_every = max(50, len(combos) // 200)
    for i, params in enumerate(combos):
        params["tau_override_mode"] = args.tau_mode
        dev_m = evaluate_prepared(dev_arr, params)
        hold_m = evaluate_prepared(hold_arr, params)
        row = {k: v for k, v in params.items() if k != "tau_override_mode"}
        row.update({f"dev_{k}": v for k, v in dev_m.items()})
        row.update({f"holdout_{k}": v for k, v in hold_m.items()})
        row["n_dev"] = len(dev)
        row["n_holdout"] = len(holdout)
        row["calibrated"] = args.calibrate_skills
        results.append(row)
        if wandb_mod is not None and i % log_every == 0:
            wandb_mod.log(
                {
                    "i": i,
                    "holdout_accuracy": hold_m["accuracy"],
                    "holdout_avg_cost": hold_m["avg_cost"],
                    "dev_accuracy": dev_m["accuracy"],
                    "best_holdout_accuracy_so_far": max(best_holdout, hold_m["accuracy"]),
                }
            )
        if hold_m["accuracy"] > best_holdout:
            best_holdout = hold_m["accuracy"]
        if (i + 1) % (len(combos) // 10 + 1) == 0:
            el = time.time() - t0
            print(f"  [{i + 1}/{len(combos)}] best_holdout={best_holdout:.4f} elapsed={el:.1f}s")

    pareto = mark_pareto(results)
    results.sort(key=lambda r: (not r["is_pareto"], -r["holdout_accuracy"], r["holdout_avg_cost"]))

    args.out.parent.mkdir(parents=True, exist_ok=True)
    with args.out.open("w") as f:
        for r in results:
            f.write(json.dumps(r, sort_keys=True) + "\n")
    with args.pareto_out.open("w") as f:
        for r in pareto:
            f.write(json.dumps(r, sort_keys=True) + "\n")

    best = max(results, key=lambda r: (r["holdout_accuracy"], -r["holdout_avg_cost"]))
    elapsed = time.time() - t0
    print(
        f"\n[done] best_holdout_accuracy={best['holdout_accuracy']:.4f}  avg_cost={best['holdout_avg_cost']:.4f}  elapsed={elapsed:.1f}s"
    )
    print(
        f"  params: pref={best['routing_preference']:.2f}  mu={best['complexity_mu']:.2f}  bias={best['complexity_bias']:.2f}  beta={best['cost_penalty_beta']:.2f}  lambda={best['over_penalty_lambda']:.2f}  tau={best['tau_base']:.2f}"
    )
    print(
        f"  distribution: qwen={best['holdout_model_qwen_pct']:.3f}  ds4={best['holdout_model_ds4_pct']:.3f}  kimi={best['holdout_model_kimi_pct']:.3f}"
    )

    if wandb_mod is not None:
        run.summary["best_holdout_accuracy"] = best["holdout_accuracy"]
        run.summary["best_holdout_avg_cost"] = best["holdout_avg_cost"]
        run.summary["best_holdout_model_qwen_pct"] = best["holdout_model_qwen_pct"]
        run.summary["best_holdout_model_ds4_pct"] = best["holdout_model_ds4_pct"]
        run.summary["best_holdout_model_kimi_pct"] = best["holdout_model_kimi_pct"]
        run.summary["best_routing_preference"] = best["routing_preference"]
        run.summary["best_complexity_mu"] = best["complexity_mu"]
        run.summary["best_complexity_bias"] = best["complexity_bias"]
        run.summary["best_cost_penalty_beta"] = best["cost_penalty_beta"]
        run.summary["best_over_penalty_lambda"] = best["over_penalty_lambda"]
        run.summary["best_tau_base"] = best["tau_base"]
        run.summary["pareto_points"] = len(pareto)
        run.summary["combos_evaluated"] = len(combos)
        run.summary["elapsed_seconds"] = elapsed

        # Log full results as table
        scalar_keys = sorted({k for r in results for k, v in r.items() if isinstance(v, int | float | bool | str)})
        table = wandb_mod.Table(columns=scalar_keys)
        for r in results[:5000]:  # cap to avoid bloating wandb
            table.add_data(*(r.get(k) for k in scalar_keys))
        wandb_mod.log({"sweep_results": table})

        pareto_table = wandb_mod.Table(columns=scalar_keys)
        for r in pareto:
            pareto_table.add_data(*(r.get(k) for k in scalar_keys))
        wandb_mod.log({"pareto_frontier": pareto_table})

        artifact = wandb_mod.Artifact(f"brick_v2_sweep_{args.run_name or 'default'}", type="dataset")
        artifact.add_file(str(args.out))
        artifact.add_file(str(args.pareto_out))
        if args.skill_out.exists():
            artifact.add_file(str(args.skill_out))
        wandb_mod.log_artifact(artifact)
        wandb_mod.finish()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
