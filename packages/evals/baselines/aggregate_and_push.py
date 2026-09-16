#!/usr/bin/env python3
"""Aggregate RouteLLM, FrugalGPT and Cascade predictions into the Hub predictions subset. Each query includes selected models, call counts and cascade costs/probabilities."""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

import pandas as pd

if (Path.home() / ".hf_token_regolo").exists():
    os.environ["HF_TOKEN"] = (Path.home() / ".hf_token_regolo").read_text().strip()

REPO = "massaindustries/dataset-A-routing"
PREDICTIONS_DIR = Path(os.environ.get("BRICK_BASELINE_OUTPUT", "./baseline-output"))
OUT_PARQUET = PREDICTIONS_DIR / "merged.parquet"
OUT_JSONL = PREDICTIONS_DIR / "merged.jsonl.gz"


def load_jsonl(path: Path) -> pd.DataFrame:
    rows = []
    with path.open() as f:
        for line in f:
            try:
                rows.append(json.loads(line))
            except Exception:
                pass
    df = pd.DataFrame(rows)
    df = df[df["query_id"] != "_schema_anchor"]
    return df


def main():
    routellm = load_jsonl(PREDICTIONS_DIR / "routellm.jsonl").set_index("query_id")
    frugal = load_jsonl(PREDICTIONS_DIR / "frugalgpt.jsonl").set_index("query_id")
    cascade = load_jsonl(PREDICTIONS_DIR / "cascade_routing.jsonl").set_index("query_id")

    print(f"routellm: {len(routellm)} rows, cols={list(routellm.columns)}")
    print(f"frugal: {len(frugal)} rows, cols={list(frugal.columns)}")
    print(f"cascade: {len(cascade)} rows, cols={list(cascade.columns)}")

    # Pick dimension from routellm (any will do)
    base = routellm[["dimension"]].copy()
    # Rename overlapping cols to drop
    routellm_cols = routellm.drop(columns=["dimension", "error"], errors="ignore")
    frugal_cols = frugal.drop(columns=["dimension", "error", "frugal_scores"], errors="ignore")
    cascade_cols = cascade.drop(columns=["dimension"], errors="ignore")

    # Flatten dict columns
    if "frugal_scores" in frugal.columns:
        for m in ("qwen", "ds4", "kimi"):
            frugal_cols[f"frugal_score_{m}"] = frugal["frugal_scores"].apply(
                lambda d, m=m: d.get(m) if isinstance(d, dict) else None
            )
    if "cascade_p_correct" in cascade.columns:
        for m in ("qwen", "ds4", "kimi"):
            cascade_cols[f"cascade_p_correct_{m}"] = cascade["cascade_p_correct"].apply(
                lambda d, m=m: d.get(m) if isinstance(d, dict) else None
            )
        cascade_cols = cascade_cols.drop(columns=["cascade_p_correct", "cascade_utility"], errors="ignore")

    merged = base.join(routellm_cols, how="outer").join(frugal_cols, how="outer").join(cascade_cols, how="outer")
    merged = merged.reset_index()
    print(f"merged: {len(merged)} rows × {len(merged.columns)} cols")
    print(f"cols: {list(merged.columns)}")
    print(merged.head(3).to_string())

    PREDICTIONS_DIR.mkdir(parents=True, exist_ok=True)
    merged.to_parquet(OUT_PARQUET, index=False)
    merged.to_json(OUT_JSONL, orient="records", lines=True, compression="gzip", force_ascii=False)
    print(f"\nSaved {OUT_PARQUET} ({OUT_PARQUET.stat().st_size / 1e6:.2f} MB)")
    print(f"Saved {OUT_JSONL} ({OUT_JSONL.stat().st_size / 1e6:.2f} MB)")

    if "--push" in sys.argv:
        from huggingface_hub import HfApi

        api = HfApi()
        api.upload_file(
            path_or_fileobj=str(OUT_JSONL),
            path_in_repo="predictions/train.jsonl.gz",
            repo_id=REPO,
            repo_type="dataset",
            token=os.environ["HF_TOKEN"],
        )
        print(f"Pushed to HF dataset {REPO} as predictions subset")


if __name__ == "__main__":
    main()
