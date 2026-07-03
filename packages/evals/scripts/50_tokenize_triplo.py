#!/usr/bin/env python3
"""50 - Tokenize triplo: input_tokens_qwen/deepseek/kimi via 3 tokenizer (batch=64).

Modifica IN-PLACE data/final/evaluation_parameters_full.jsonl.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from brick_evals.io_utils import data_dir, load_jsonl, save_jsonl
from brick_evals.tokenizers import count_tokens_batch

BATCH = 64


def main():
    in_path = data_dir("final") / "evaluation_parameters_full.jsonl"
    rows = list(load_jsonl(in_path))
    print(f"loaded {len(rows)} rows from {in_path.name}")

    queries = [r["query"] for r in rows]

    print("tokenizing with qwen3.5-9b...")
    qwen = count_tokens_batch(queries, "qwen3.5-9b", batch_size=BATCH)
    print(f"  done. min={min(qwen)} max={max(qwen)} mean={sum(qwen)//len(qwen)}")

    print("tokenizing with deepseek-v4-flash (proxy V3)...")
    try:
        ds = count_tokens_batch(queries, "deepseek-v4-flash", batch_size=BATCH)
        print(f"  done. min={min(ds)} max={max(ds)} mean={sum(ds)//len(ds)}")
    except Exception as e:
        print(f"  [warn] deepseek tokenizer failed: {e}; using qwen as fallback")
        ds = qwen[:]

    print("tokenizing with kimi2.6 (proxy K2.5)...")
    try:
        ki = count_tokens_batch(queries, "kimi2.6", batch_size=BATCH)
        print(f"  done. min={min(ki)} max={max(ki)} mean={sum(ki)//len(ki)}")
    except Exception as e:
        print(f"  [warn] kimi tokenizer failed: {e}; using qwen as fallback")
        ki = qwen[:]

    for r, q, d, k in zip(rows, qwen, ds, ki, strict=False):
        r["input_tokens_qwen"] = q
        r["input_tokens_deepseek"] = d
        r["input_tokens_kimi"] = k

    save_jsonl(in_path, rows)
    print(f"\nsaved tokens in-place -> {in_path}")


if __name__ == "__main__":
    main()
