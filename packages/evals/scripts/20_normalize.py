#!/usr/bin/env python3
"""20 - Normalize raw -> schema target.

Usa src/brick_evals/normalize/normalizers.py::NORMALIZERS registry.

Usage:
    python 20_normalize.py <source_id>
    python 20_normalize.py --all

Input: data/raw/<source_id>.jsonl
Output: data/normalized/<source_id>.jsonl (schema parziale: query, expected_answer,
        language, difficulty_band, length_band, dataset_release_date, contamination_risk,
        gated, license, source_label + raw row preserved as _raw)
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from brick_evals.io_utils import configs_dir, data_dir, load_jsonl, load_yaml, save_jsonl
from brick_evals.normalize import NORMALIZERS, normalize


def normalize_source(source_id: str) -> int:
    raw_path = data_dir("raw") / f"{source_id}.jsonl"
    if not raw_path.exists():
        print(f"  [SKIP] raw file not found: {raw_path}")
        return 0
    out_path = data_dir("normalized") / f"{source_id}.jsonl"

    rows_in = list(load_jsonl(raw_path))
    if not rows_in:
        print(f"  [SKIP] {source_id}: 0 raw rows")
        save_jsonl(out_path, [])
        return 0

    if source_id not in NORMALIZERS:
        print(f"  [WARN] no normalizer for {source_id}")
        return 0

    out_rows = []
    errors = 0
    for r in rows_in:
        try:
            n = normalize(source_id, r)
            n["_raw"] = r  # preserve for debug/audit
            out_rows.append(n)
        except Exception as e:
            errors += 1
            if errors <= 3:
                print(f"  [warn] normalize error: {type(e).__name__}: {e}")

    n_written = save_jsonl(out_path, out_rows)
    print(f"  {source_id:30s}: {n_written} normalized (errors: {errors}) -> {out_path.name}")
    return n_written


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("source_id", nargs="?")
    ap.add_argument("--all", action="store_true")
    ap.add_argument("--list", action="store_true")
    args = ap.parse_args()

    if args.list:
        for sid in NORMALIZERS:
            print(sid)
        return 0

    if args.all:
        sources = load_yaml(configs_dir() / "sources.yaml")
        ids = [sid for sid in sources if not sid.startswith("_")]
        total = 0
        for sid in ids:
            total += normalize_source(sid)
        print(f"\nTOTAL normalized: {total}")
        return 0

    if not args.source_id:
        ap.print_help()
        return 1
    normalize_source(args.source_id)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
