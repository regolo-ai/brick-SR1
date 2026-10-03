#!/usr/bin/env python3
"""Patch encoding: rimuove control char (\\x0b, etc.) e fixa mojibake via ftfy.

Operazioni in-place su evaluation_parameters_full.jsonl + _masked.jsonl.
Re-tokenize delle righe modificate per coerenza.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "src"))

import ftfy
from brick_evals.io_utils import data_dir, load_jsonl, save_jsonl
from brick_evals.tokenizers import count_tokens

DISALLOWED_CTRL = set(chr(c) for c in list(range(0, 9)) + [11, 12] + list(range(14, 32)) + [127])


def clean_text(s: str) -> tuple[str, bool]:
    """Returns (cleaned, was_modified)."""
    original = s
    s2 = "".join(c if c not in DISALLOWED_CTRL else " " for c in s)
    if ftfy.is_bad(s2):
        s2 = ftfy.fix_text(s2)
    return s2, s2 != original


def patch_file(path: Path) -> int:
    rows = list(load_jsonl(path))
    n_modified = 0
    for r in rows:
        cleaned, mod = clean_text(r["query"])
        if mod:
            r["query"] = cleaned
            # re-tokenize
            r["input_tokens_qwen"] = count_tokens(cleaned, "qwen3.5-9b")
            r["input_tokens_deepseek"] = count_tokens(cleaned, "deepseek-v4-flash")
            r["input_tokens_kimi"] = count_tokens(cleaned, "kimi2.6")
            n_modified += 1
    if n_modified:
        save_jsonl(path, rows)
    return n_modified


def main():
    full = data_dir("final") / "evaluation_parameters_full.jsonl"
    masked = data_dir("final") / "evaluation_parameters_masked.jsonl"

    n_full = patch_file(full)
    print(f"[patch_encoding] full: modified {n_full} rows")
    if masked.exists():
        n_masked = patch_file(masked)
        print(f"[patch_encoding] masked: modified {n_masked} rows")


if __name__ == "__main__":
    main()
