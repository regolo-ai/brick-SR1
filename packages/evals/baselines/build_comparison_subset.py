#!/usr/bin/env python3
"""Build subset `comparison` per HF push.

Schema (5504 rows):
  query_id, dimension, ground_truth, gt_qwen_correct, gt_ds4_correct, gt_kimi_correct,
  routellm_binary_selected, routellm_binary_latency_ms, routellm_binary_correct,
  routellm_tournament_selected, routellm_tournament_latency_ms, routellm_tournament_correct,
  frugal_first_tried, frugal_router_latency_ms, frugal_correct,
  cascade_selected, cascade_router_latency_ms, cascade_correct

Ground truth: qwen > ds4 > kimi cheapest correct; fallback kimi.
FrugalGPT first_tried: hardcoded "qwen" (cascade order).
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

import pandas as pd
from datasets import load_dataset

if (Path.home() / ".hf_token_regolo").exists():
    os.environ["HF_TOKEN"] = (Path.home() / ".hf_token_regolo").read_text().strip()

REPO = "massaindustries/dataset-A-routing"
PRED_DIR = Path(os.environ.get("BRICK_BASELINE_OUTPUT", "./baseline-output"))
OUT_JSONL = PRED_DIR / "comparison.jsonl.gz"


def load_jsonl(path: Path, cols: list[str]) -> pd.DataFrame:
    rows = []
    with path.open() as f:
        for line in f:
            try:
                rows.append(json.loads(line))
            except Exception:
                pass
    df = pd.DataFrame(rows)
    df = df[df["query_id"] != "_schema_anchor"]
    keep = [c for c in cols if c in df.columns]
    return df[keep]


def derive_gt(row):
    if row.get("qwen_correct") is True:
        return "qwen"
    if row.get("ds4_correct") is True:
        return "ds4"
    if row.get("kimi_correct") is True:
        return "kimi"
    return "kimi"


def main():
    print("Loading results from HF...")
    ds = load_dataset(REPO, "results", split="train")
    res = ds.to_pandas()
    res = res[res["query_id"] != "_schema_anchor"].copy()
    res["ground_truth"] = res.apply(derive_gt, axis=1)
    res = res.rename(
        columns={"qwen_correct": "gt_qwen_correct", "ds4_correct": "gt_ds4_correct", "kimi_correct": "gt_kimi_correct"}
    )
    base = res[["query_id", "dimension", "ground_truth", "gt_qwen_correct", "gt_ds4_correct", "gt_kimi_correct"]]
    print(f"  base: {len(base)} rows")

    print("Loading 4 router predictions (3 baseline + Brick)...")
    rl = load_jsonl(
        PRED_DIR / "routellm.jsonl",
        [
            "query_id",
            "routellm_binary_selected",
            "routellm_binary_latency_ms",
            "routellm_tournament_selected",
            "routellm_tournament_latency_ms",
        ],
    )
    fg = load_jsonl(PRED_DIR / "frugalgpt.jsonl", ["query_id", "frugal_router_latency_ms"])
    cr = load_jsonl(PRED_DIR / "cascade_routing.jsonl", ["query_id", "cascade_selected", "cascade_router_latency_ms"])
    br = load_jsonl(
        PRED_DIR / "brick.jsonl", ["query_id", "brick_selected", "brick_route_reason", "brick_router_latency_ms"]
    )
    print(f"  routellm: {len(rl)}  frugal: {len(fg)}  cascade: {len(cr)}  brick: {len(br)}")

    df = (
        base.merge(rl, on="query_id", how="left")
        .merge(fg, on="query_id", how="left")
        .merge(cr, on="query_id", how="left")
        .merge(br, on="query_id", how="left")
    )

    df["frugal_first_tried"] = "qwen"
    df["routellm_binary_correct"] = df["routellm_binary_selected"] == df["ground_truth"]
    df["routellm_tournament_correct"] = df["routellm_tournament_selected"] == df["ground_truth"]
    df["frugal_correct"] = df["frugal_first_tried"] == df["ground_truth"]
    df["cascade_correct"] = df["cascade_selected"] == df["ground_truth"]
    df["brick_correct"] = df["brick_selected"] == df["ground_truth"]

    cols = [
        "query_id",
        "dimension",
        "ground_truth",
        "gt_qwen_correct",
        "gt_ds4_correct",
        "gt_kimi_correct",
        "routellm_binary_selected",
        "routellm_binary_latency_ms",
        "routellm_binary_correct",
        "routellm_tournament_selected",
        "routellm_tournament_latency_ms",
        "routellm_tournament_correct",
        "frugal_first_tried",
        "frugal_router_latency_ms",
        "frugal_correct",
        "cascade_selected",
        "cascade_router_latency_ms",
        "cascade_correct",
        "brick_selected",
        "brick_route_reason",
        "brick_router_latency_ms",
        "brick_correct",
    ]
    df = df[cols]
    print(f"\nbuilt comparison: {len(df)} rows × {len(df.columns)} cols")
    print(df.head(3).to_string())

    df.to_json(OUT_JSONL, orient="records", lines=True, compression="gzip", force_ascii=False)
    print(f"\nSaved {OUT_JSONL} ({OUT_JSONL.stat().st_size / 1e3:.1f} KB)")

    # Stats riepilogo
    print("\n=== Stats summary ===")
    for name, _pred_col, lat_col, corr_col in [
        ("RouteLLM binary", "routellm_binary_selected", "routellm_binary_latency_ms", "routellm_binary_correct"),
        (
            "RouteLLM tournament",
            "routellm_tournament_selected",
            "routellm_tournament_latency_ms",
            "routellm_tournament_correct",
        ),
        ("FrugalGPT cascade", "frugal_first_tried", "frugal_router_latency_ms", "frugal_correct"),
        ("Cascade Routing", "cascade_selected", "cascade_router_latency_ms", "cascade_correct"),
        ("Brick", "brick_selected", "brick_router_latency_ms", "brick_correct"),
    ]:
        acc = df[corr_col].mean()
        lat = df[lat_col].dropna()
        print(
            f"  [{name}] acc={acc:.4f}  latency_ms mean={lat.mean():.2f}  median={lat.median():.2f}  p95={lat.quantile(0.95):.2f}  p99={lat.quantile(0.99):.2f}"
        )

    if "--push" in sys.argv:
        from huggingface_hub import HfApi

        api = HfApi()
        api.upload_file(
            path_or_fileobj=str(OUT_JSONL),
            path_in_repo="comparison/train.jsonl.gz",
            repo_id=REPO,
            repo_type="dataset",
            token=os.environ["HF_TOKEN"],
        )
        print(f"\nPushed to HF dataset {REPO} as comparison subset")


if __name__ == "__main__":
    main()
