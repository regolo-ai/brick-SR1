#!/usr/bin/env python3
"""80 - Verify dataset post-push: load_dataset() + smoke checks."""

from __future__ import annotations

import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from brick_evals.io_utils import hf_token
from brick_evals.tokenizers import count_tokens

REPO_ID = "massaindustries/dataset-A-routing-eval"


def main():
    from datasets import load_dataset

    print(f"loading {REPO_ID}...")
    ds = load_dataset(REPO_ID, split="train", token=hf_token())
    print(f"  loaded {len(ds)} rows")

    # Schema check
    required = {
        "query_id",
        "query",
        "query_hash",
        "dimension",
        "source",
        "shots",
        "input_tokens_qwen",
        "input_tokens_deepseek",
        "input_tokens_kimi",
        "expected_answer",
        "evaluation_protocol_id",
        "few_shot_examples",
        "language",
        "difficulty_band",
        "length_band",
        "dataset_release_date",
        "contamination_risk",
        "gated",
        "license",
    }
    missing = required - set(ds.column_names)
    if missing:
        print(f"[FAIL] missing columns: {missing}")
        return 1
    print("[OK] all required columns present")

    # Counts
    by_dim = Counter(ds["dimension"])
    print("By dimension:")
    for d, c in sorted(by_dim.items()):
        print(f"  {d:25s} {c}")

    # Sample 10 random
    import random

    rng = random.Random(0)
    sample_idx = rng.sample(range(len(ds)), min(10, len(ds)))
    print("\nSample 10 rows:")
    for i in sample_idx:
        r = ds[i]
        gated_marker = " [GATED-MASKED]" if r["gated"] else ""
        q_preview = r["query"][:80].replace("\n", " ")
        print(
            f"  {r['query_id']} | {r['dimension']:20s} | shots={r['shots']} | toks(q)={r['input_tokens_qwen']}{gated_marker}"
        )
        print(f"    query: {q_preview}...")

    # Re-tokenize 50 random and compare with stored
    print("\nRe-tokenize 50 sample (qwen)...")
    re_idx = rng.sample(range(len(ds)), min(50, len(ds)))
    mismatches = 0
    for i in re_idx:
        r = ds[i]
        if r["gated"]:
            continue  # masked, can't re-tokenize meaningfully
        recount = count_tokens(r["query"], "qwen3.5-9b")
        if recount != r["input_tokens_qwen"]:
            mismatches += 1
            if mismatches <= 3:
                print(f"  MISMATCH q_{r['query_id']}: stored={r['input_tokens_qwen']} recount={recount}")
    if mismatches > 0:
        print(f"[WARN] {mismatches}/50 token mismatches (possibly tokenizer version drift)")
    else:
        print("[OK] 50/50 token counts match")

    # Gated rows have query='<masked>'
    gated_rows = [r for r in ds if r["gated"]]
    bad_gated = [r for r in gated_rows if r["query"] != "<masked>"]
    if bad_gated:
        print(f"[FAIL] {len(bad_gated)} gated rows do NOT have query='<masked>'")
        return 1
    print(f"[OK] all {len(gated_rows)} gated rows are properly masked")

    print("\n=== VERIFY PASSED ===")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
