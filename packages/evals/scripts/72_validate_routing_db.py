#!/usr/bin/env python3
"""72b - Validate dataset_A_routing parquet locali (read-only).

Checks:
- 5339 righe per config
- query_id univoche
- per-dimension count match dataset base
- nessuna riga con tutti i *_correct null
- stampa win-rate stats

Usage:
    python3 scripts/72_validate_routing_db.py
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from brick_evals.io_utils import data_dir

EXPECTED_TOTAL = 5505  # 5339 base + 165 multi_turn + 1 schema-anchor row (query_id='_schema_anchor')
EXPECTED_BY_DIM = {
    "planning_agentic": 1000,
    "planning_agentic_multiturn": 165,
    "math_reasoning": 1000,
    "coding": 1000,
    "instruction_following": 841,
    "world_knowledge": 802,
    "creative_synthesis": 696,
    "_anchor_": 1,
}


def main():
    import pandas as pd

    out_dir = data_dir("final") / "dataset_A_routing"
    if not out_dir.exists():
        print(f"FAIL: missing {out_dir}. Run 72_push_dataset_a_routing.py --dry-run first.")
        sys.exit(1)

    ok = True

    cfg_files = {
        "evals": "train.jsonl.gz",
        "results": "train.jsonl.gz",
        "verbose": "train.jsonl.gz",
    }
    import gzip
    import json as _json
    from collections import Counter

    for cfg, fname in cfg_files.items():
        path = out_dir / cfg / fname
        size_mb = path.stat().st_size / 1e6
        print(f"\n=== {cfg} ({size_mb:.2f} MB) ===")
        qids = set()
        n_rows = 0
        by_dim_counter: Counter = Counter()
        with gzip.open(str(path), "rt", encoding="utf-8") as f:
            for line in f:
                rec = _json.loads(line)
                qids.add(rec["query_id"])
                by_dim_counter[rec.get("dimension", "")] += 1
                n_rows += 1
        n_uniq = len(qids)
        by_dim = dict(by_dim_counter)
        print(f"  rows: {n_rows}")
        if n_rows != EXPECTED_TOTAL:
            print(f"  FAIL: expected {EXPECTED_TOTAL} rows, got {n_rows}")
            ok = False
        if n_uniq != n_rows:
            print(f"  FAIL: query_id not unique ({n_uniq} unique vs {n_rows} rows)")
            ok = False
        if by_dim:
            print(f"  by_dim: {by_dim}")
            for dim, exp in EXPECTED_BY_DIM.items():
                if by_dim.get(dim, 0) != exp:
                    print(f"  FAIL: {dim} expected {exp}, got {by_dim.get(dim, 0)}")
                    ok = False

    print("\n=== results: win-rate ===")
    results = pd.read_json(out_dir / "results" / "train.jsonl.gz", lines=True, compression="gzip")
    for m in ("qwen", "ds4", "kimi"):
        col = results[f"{m}_correct"]
        n_t = int((col == True).sum())  # noqa: E712
        n_f = int((col == False).sum())  # noqa: E712
        n_n = int(col.isna().sum())
        denom = n_t + n_f
        acc = n_t / denom if denom else 0.0
        print(f"  {m}: correct={n_t}, incorrect={n_f}, abstention={n_n}, acc={acc:.4f}")

    all_null = results[["qwen_correct", "ds4_correct", "kimi_correct"]].isna().all(axis=1)
    n_all_null = int(all_null.sum())
    print(f"\n  rows with all 3 verdict null: {n_all_null}")
    if n_all_null > 0:
        print(f"  WARN: {n_all_null} rows have no verdict for any model")
        print(results[all_null][["query_id", "dimension", "evaluation_protocol_id"]].head(10))

    print("\n=== per-dimension win-rate ===")
    for dim in EXPECTED_BY_DIM:
        sub = results[results["dimension"] == dim]
        n = len(sub)
        cells = []
        for m in ("qwen", "ds4", "kimi"):
            col = sub[f"{m}_correct"]
            denom = int((col == True).sum()) + int((col == False).sum())  # noqa: E712
            acc = int((col == True).sum()) / denom if denom else 0.0  # noqa: E712
            cells.append(f"{m}={acc:.3f}")
        print(f"  {dim:25s} (n={n:4d}): {' | '.join(cells)}")

    print("\n=== verbose: response coverage ===")
    verbose = pd.read_json(out_dir / "verbose" / "train.jsonl.gz", lines=True, compression="gzip")
    for m in ("qwen", "ds4", "kimi"):
        nonempty = (verbose[f"{m}_response"].fillna("") != "").sum()
        print(f"  {m}_response non-empty: {nonempty}/{len(verbose)}")

    print("\n=== verbose: individual judges (planning ST) ===")
    # heuristic: planning ST queries appear in graded panel; check non-null individual judges
    for m in ("qwen", "ds4", "kimi"):
        nonnull = verbose[f"{m}_judge_gpt54mini"].notna().sum()
        print(f"  {m}_judge_gpt54mini non-null: {nonnull}")

    print(f"\n{'PASS' if ok else 'FAIL'}")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
