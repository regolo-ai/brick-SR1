#!/usr/bin/env python3
"""00 - Load Dataset A (results + verbose) from HF and inspect schema."""

from __future__ import annotations

import os
from pathlib import Path

from datasets import load_dataset

TOKEN_PATH = Path.home() / ".hf_token_regolo"
if TOKEN_PATH.exists():
    os.environ["HF_TOKEN"] = TOKEN_PATH.read_text().strip()

REPO = "massaindustries/dataset-A-routing"


def main():
    print(f"Loading {REPO} subset=results")
    ds_results = load_dataset(REPO, "results", split="train")
    print(f"  rows: {len(ds_results)}")
    print(f"  columns: {ds_results.column_names}")
    print(f"  first row: {ds_results[0]}")

    print(f"\nLoading {REPO} subset=verbose")
    ds_verbose = load_dataset(REPO, "verbose", split="train")
    print(f"  rows: {len(ds_verbose)}")
    print(f"  columns: {ds_verbose.column_names}")
    sample = ds_verbose[0]
    for k, v in sample.items():
        s = str(v)
        print(f"  [{k}] = {s[:160]}{'...' if len(s) > 160 else ''}")

    print("\n=== response coverage in verbose ===")
    for m in ("qwen", "ds4", "kimi"):
        col = f"{m}_response"
        if col in ds_verbose.column_names:
            non_empty = sum(1 for r in ds_verbose[col] if r and r.strip())
            print(f"  {col}: non-empty={non_empty}/{len(ds_verbose)}")
        else:
            print(f"  {col}: MISSING")


if __name__ == "__main__":
    main()
