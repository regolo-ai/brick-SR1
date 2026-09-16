#!/usr/bin/env python3
"""Select eco/balanced/pro profiles from Brick risk sweep results."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
from typing import Any

IN_JSONL = Path(os.environ.get("BRICK_BASELINE_OUTPUT", "./baseline-output")) / "brick_risk_sweep.jsonl"
OUT_JSON = Path(os.environ.get("BRICK_BASELINE_OUTPUT", "./baseline-output")) / "brick_risk_profiles.json"
OUT_YAML = Path(os.environ.get("BRICK_BASELINE_OUTPUT", "./baseline-output")) / "brick_risk_profiles.yaml"
PARAM_KEYS = (
    "routing_preference",
    "complexity_mu",
    "complexity_bias",
    "cost_penalty_beta",
    "over_penalty_lambda",
)


def load_rows(path: Path) -> list[dict[str, Any]]:
    with path.open() as f:
        return [json.loads(line) for line in f if line.strip()]


def pareto_rows(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    marked = [row for row in rows if row.get("is_pareto") is True]
    if marked:
        return marked
    ordered = sorted(rows, key=lambda row: (row["holdout_avg_cost"], -row["holdout_accuracy"]))
    out = []
    best_acc = -1.0
    for row in ordered:
        if row["holdout_accuracy"] > best_acc + 1e-12:
            out.append(row)
            best_acc = row["holdout_accuracy"]
    return out


def params(row: dict[str, Any]) -> dict[str, float]:
    return {key: float(row[key]) for key in PARAM_KEYS}


def profile_payload(name: str, row: dict[str, Any]) -> dict[str, Any]:
    return {
        "name": name,
        "math": params(row),
        "metrics": {
            "holdout_accuracy": row["holdout_accuracy"],
            "holdout_avg_cost": row["holdout_avg_cost"],
            "holdout_cost_per_correct": row["holdout_cost_per_correct"],
            "holdout_over_route_rate": row["holdout_over_route_rate"],
            "holdout_under_route_rate": row["holdout_under_route_rate"],
            "holdout_model_qwen_pct": row["holdout_model_qwen_pct"],
            "holdout_model_ds4_pct": row["holdout_model_ds4_pct"],
            "holdout_model_kimi_pct": row["holdout_model_kimi_pct"],
        },
    }


def write_yaml(path: Path, profiles: dict[str, Any]) -> None:
    lines = ["routing_profiles:"]
    for name, profile in profiles.items():
        lines.append(f"  {name}:")
        lines.append("    math:")
        for key in PARAM_KEYS:
            lines.append(f"      {key}: {profile['math'][key]:.8g}")
        lines.append("    metrics:")
        for key, value in profile["metrics"].items():
            lines.append(f"      {key}: {value:.8g}")
    path.write_text("\n".join(lines) + "\n")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", type=Path, default=IN_JSONL)
    parser.add_argument("--out-json", type=Path, default=OUT_JSON)
    parser.add_argument("--out-yaml", type=Path, default=OUT_YAML)
    parser.add_argument("--baseline-accuracy", type=float, default=0.6317)
    parser.add_argument("--balanced-alpha", type=float, default=0.5)
    args = parser.parse_args()

    rows = load_rows(args.input)
    frontier = pareto_rows(rows)
    if not frontier:
        raise SystemExit("no rows available")

    eco_candidates = [row for row in frontier if row["holdout_accuracy"] >= args.baseline_accuracy]
    if not eco_candidates:
        eco_candidates = frontier
    eco = min(eco_candidates, key=lambda row: (row["holdout_avg_cost"], -row["holdout_accuracy"]))
    balanced = max(
        frontier,
        key=lambda row: (
            row["holdout_accuracy"] - args.balanced_alpha * row["holdout_avg_cost"],
            row["holdout_accuracy"],
        ),
    )
    pro = max(frontier, key=lambda row: (row["holdout_accuracy"], -row["holdout_avg_cost"]))

    profiles = {
        "eco": profile_payload("eco", eco),
        "balanced": profile_payload("balanced", balanced),
        "pro": profile_payload("pro", pro),
    }
    args.out_json.parent.mkdir(parents=True, exist_ok=True)
    args.out_json.write_text(json.dumps(profiles, indent=2, sort_keys=True) + "\n")
    write_yaml(args.out_yaml, profiles)

    for name, profile in profiles.items():
        metrics = profile["metrics"]
        print(
            f"{name}: acc={metrics['holdout_accuracy']:.4f} "
            f"avg_cost={metrics['holdout_avg_cost']:.4f} params={profile['math']}"
        )
    print(f"wrote {args.out_json} and {args.out_yaml}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
