#!/usr/bin/env python3
"""Fit Brick risk-adjusted routing parameters on Dataset A diagnostics.

The current comparison artifact does not store per-query Brick internals
(capability probabilities, raw complexity label/confidence, or per-model
scores). This script therefore fits an oracle diagnostic variant that uses the
known benchmark dimension as the capability signal. It is useful for estimating
headroom and initializing config values, not for a zero-shot paper claim.
"""

from __future__ import annotations

import argparse
import gzip
import itertools
import json
import math
from collections import Counter, defaultdict
from pathlib import Path


MODELS = ("qwen", "ds4", "kimi")
CAPABILITIES = (
    "coding",
    "creative_synthesis",
    "instruction_following",
    "math_reasoning",
    "planning_agentic",
    "planning_agentic_multiturn",
    "world_knowledge",
)
CAP_INDEX = {name: i for i, name in enumerate(CAPABILITIES)}

# Current spatial-routing/config/config.yaml values, mapped to short model ids.
# planning_agentic_multiturn is not part of the production capability model yet,
# so it reuses planning_agentic in this diagnostic.
SKILL_VECTORS = {
    "qwen": [0.714788, 0.511538, 0.810109, 0.912146, 0.577072, 0.577072, 0.179876],
    "ds4": [0.820939, 0.657845, 0.863112, 0.934963, 0.620550, 0.620550, 0.488518],
    "kimi": [0.904272, 0.751595, 0.870180, 0.943892, 0.641863, 0.641863, 0.344074],
}
COST = {"qwen": 0.10, "ds4": 0.40, "kimi": 0.60}


def logit(value: float) -> float:
    value = min(max(value, 1e-6), 1 - 1e-6)
    return math.log(value / (1 - value))


def predict(dim: str, tau: float, mu: float, bias: float, beta: float, lam: float) -> str:
    zq = bias + mu * logit(tau)
    i = CAP_INDEX[dim]
    best: tuple[float, str] | None = None
    for model in MODELS:
        zm = logit(SKILL_VECTORS[model][i])
        under = max(0.0, zq - zm)
        over = max(0.0, zm - zq)
        distance = math.sqrt(under * under + lam * over * over)
        score = distance + beta * COST[model]
        item = (score, model)
        if best is None or item < best:
            best = item
    assert best is not None
    return best[1]


def load_rows(path: Path) -> list[dict]:
    with gzip.open(path, "rt") as f:
        return [json.loads(line) for line in f if line.strip()]


def accuracy(rows: list[dict], params: tuple[float, float, float, float, float]) -> tuple[float, dict[str, str]]:
    tau, mu, bias, beta, lam = params
    pred_by_dim = {
        dim: predict(dim, tau=tau, mu=mu, bias=bias, beta=beta, lam=lam)
        for dim in CAPABILITIES
    }
    hits = 0
    for row in rows:
        hits += pred_by_dim[row["dimension"]] == row["ground_truth"]
    return hits / len(rows), pred_by_dim


def best_fixed_by_dimension(rows: list[dict]) -> tuple[float, dict[str, str]]:
    by_dim: dict[str, list[dict]] = defaultdict(list)
    for row in rows:
        by_dim[row["dimension"]].append(row)
    hits = 0
    pred_by_dim = {}
    for dim, group in by_dim.items():
        model, count = Counter(row["ground_truth"] for row in group).most_common(1)[0]
        pred_by_dim[dim] = model
        hits += count
    return hits / len(rows), pred_by_dim


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--comparison",
        type=Path,
        default=Path("external_comparison/predictions/comparison.jsonl.gz"),
    )
    parser.add_argument("--top-k", type=int, default=12)
    args = parser.parse_args()

    rows = load_rows(args.comparison)
    grid = {
        "tau": [0.55, 0.62, 0.72, 0.80, 0.88],
        "mu": [0.25, 0.40, 0.55, 0.70, 0.85, 1.00, 1.20, 1.50, 2.00],
        "bias": [-1.00, -0.60, -0.30, 0.00, 0.30, 0.60, 1.00],
        "beta": [0.00, 0.02, 0.05, 0.10, 0.20, 0.40, 0.80, 1.20, 2.00],
        "lambda": [0.00, 0.02, 0.05, 0.10, 0.20, 0.50, 1.00, 2.00, 4.00],
    }

    results = []
    keys = ("tau", "mu", "bias", "beta", "lambda")
    for values in itertools.product(*(grid[key] for key in keys)):
        acc, pred_by_dim = accuracy(rows, values)
        results.append((acc, dict(zip(keys, values)), pred_by_dim))
    results.sort(key=lambda item: item[0], reverse=True)

    print(f"rows: {len(rows)}")
    print(f"current_brick: {sum(row['brick_correct'] for row in rows) / len(rows):.4f}")
    print(f"always_qwen: {sum(row['ground_truth'] == 'qwen' for row in rows) / len(rows):.4f}")
    bound_acc, bound_pred = best_fixed_by_dimension(rows)
    print(f"best_fixed_by_true_dimension: {bound_acc:.4f} {bound_pred}")
    print()
    for acc, params, pred_by_dim in results[: args.top_k]:
        print(f"{acc:.4f} params={params} pred_by_dim={pred_by_dim}")


if __name__ == "__main__":
    main()
