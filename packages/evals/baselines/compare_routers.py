#!/usr/bin/env python3
"""Compare first model selections to the cheapest correct reference model, falling back to Kimi for unsolved queries. FrugalGPT’s first selection is always Qwen because its cascade order is fixed. Report selection accuracy over the full dataset; this differs from final response accuracy."""

from __future__ import annotations

import os
from pathlib import Path

import pandas as pd
from datasets import load_dataset

if (Path.home() / ".hf_token_regolo").exists():
    os.environ["HF_TOKEN"] = (Path.home() / ".hf_token_regolo").read_text().strip()

REPO = "massaindustries/dataset-A-routing"
COST_PER_QUERY_USD = {"qwen": 0.07, "ds4": 0.50, "kimi": 1.00}


def derive_ground_truth(row: dict) -> str:
    if row.get("qwen_correct") is True:
        return "qwen"
    if row.get("ds4_correct") is True:
        return "ds4"
    if row.get("kimi_correct") is True:
        return "kimi"
    return "kimi"  # fallback: nessun modello risolve, ground truth = kimi (most capable)


def load_results() -> pd.DataFrame:
    ds = load_dataset(REPO, "results", split="train")
    df = ds.to_pandas()
    df = df[df["query_id"] != "_schema_anchor"].copy()
    df["ground_truth"] = df.apply(lambda r: derive_ground_truth(r), axis=1)
    df["unsolvable"] = ~((df["qwen_correct"].eq(True)) | (df["ds4_correct"].eq(True)) | (df["kimi_correct"].eq(True)))
    return df


def load_predictions() -> pd.DataFrame:
    return pd.read_parquet(Path(os.environ.get("BRICK_BASELINE_OUTPUT", "./baseline-output")) / "merged.parquet")


def main():
    print("Loading results + predictions...")
    results = load_results()
    preds = load_predictions()
    print(f"  results: {len(results)} rows ({results['unsolvable'].sum()} unsolvable → GT=kimi fallback)")
    print(f"  predictions: {len(preds)} rows")
    df = results.merge(preds, on="query_id", how="inner", suffixes=("", "_pred"))
    print(f"  merged: {len(df)} rows\n")

    # FrugalGPT prediction override: first model in cascade order = qwen always
    df["frugal_first_tried"] = "qwen"

    print("=== Ground truth distribution (with kimi fallback) ===")
    print(df["ground_truth"].value_counts().to_string())
    print()

    routers = [
        ("RouteLLM binary", "routellm_binary_selected"),
        ("RouteLLM tournament", "routellm_tournament_selected"),
        ("FrugalGPT cascade", "frugal_first_tried"),
        ("Cascade Routing", "cascade_selected"),
    ]
    baselines = [
        ("always_qwen", lambda d: pd.Series(["qwen"] * len(d), index=d.index)),
        ("always_ds4", lambda d: pd.Series(["ds4"] * len(d), index=d.index)),
        ("always_kimi", lambda d: pd.Series(["kimi"] * len(d), index=d.index)),
        ("oracle", lambda d: d["ground_truth"]),
    ]

    print("=" * 70)
    print(f"ROUTER ACCURACY (exact match vs ground truth, n={len(df)})")
    print("=" * 70)
    summary = []
    for name, col in routers:
        pred = df[col]
        n_hit = int((pred == df["ground_truth"]).sum())
        acc = n_hit / len(df)
        cost = pred.map(COST_PER_QUERY_USD).fillna(0).mean()
        dist = pred.value_counts().to_dict()
        summary.append({"router": name, "accuracy": acc, "avg_cost_per_query": float(cost), "dist": dist})
        print(f"\n[{name}]")
        print(f"  accuracy:    {acc:.4f}  ({n_hit}/{len(df)})")
        print(f"  avg_cost:    ${cost:.4f}")
        print(f"  dist:        {dist}")

    print("\n" + "=" * 70)
    print("BASELINES (reference)")
    print("=" * 70)
    for name, fn in baselines:
        pred = fn(df)
        n_hit = int((pred == df["ground_truth"]).sum())
        acc = n_hit / len(df)
        cost = pred.map(COST_PER_QUERY_USD).fillna(0).mean()
        summary.append(
            {"router": name, "accuracy": acc, "avg_cost_per_query": float(cost), "dist": pred.value_counts().to_dict()}
        )
        print(f"  [{name}]: accuracy={acc:.4f}  avg_cost=${cost:.4f}")

    # Per-dimension
    print("\n" + "=" * 70)
    print("PER-DIMENSION ACCURACY")
    print("=" * 70)
    per_dim = pd.DataFrame()
    for name, col in routers:
        per_dim[name] = df.groupby("dimension").apply(
            lambda g, col=col: (g[col] == g["ground_truth"]).mean(), include_groups=False
        )
    per_dim["always_qwen"] = df.groupby("dimension").apply(
        lambda g: ("qwen" == g["ground_truth"]).mean(), include_groups=False
    )
    print(per_dim.to_string(float_format=lambda v: f"{v:.3f}"))

    # Sanity checks
    print("\n" + "=" * 70)
    print("SANITY CHECKS")
    print("=" * 70)
    qwen_acc = (df["frugal_first_tried"] == df["ground_truth"]).mean()
    aq_acc = (df["ground_truth"] == "qwen").mean()
    print(f"  FrugalGPT acc == always_qwen acc?  {qwen_acc:.6f} == {aq_acc:.6f}  -> {abs(qwen_acc - aq_acc) < 1e-9}")
    oracle_acc = (df["ground_truth"] == df["ground_truth"]).mean()
    print(f"  Oracle acc == 1.0?                 {oracle_acc:.6f}")
    print(f"  Total rows == 5504?                 {len(df)}")

    out_csv = Path(os.environ.get("BRICK_BASELINE_OUTPUT", "./baseline-output")) / "comparison_report.csv"
    pd.DataFrame(summary).to_csv(out_csv, index=False)
    print(f"\nSaved {out_csv}")


if __name__ == "__main__":
    main()
