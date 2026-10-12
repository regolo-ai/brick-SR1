"""Dataset loading for SystemOne single-head training: query -> final_vector (6,).

Loads massaindustries/systemone-50k-train from HF Hub, builds float label
tensors of shape (6,) from `final_vector`, tokenizes at 8192 (full-context),
stratifies 90/10 train/val on the `disagreement` bool.

Public API mirrors modernbert/dataset_loader.py:
    build_train_val(tokenizer, max_length=8192, val_ratio=0.1, seed=42)
"""
from __future__ import annotations

import os

from datasets import load_dataset

DIMS = ["instruction_following", "coding", "math_reasoning",
        "world_knowledge", "planning_agentic", "creative_synthesis"]

HF_REPO = "massaindustries/systemone-50k-train"
# v3 file supersedes v2 (it already contains all v1+v2 rows + ultra-short pairs).
# Pin the file to avoid double-counting rows.
HF_FILE = "systemone_v3.parquet"

# Canonical order check against parquet metadata (dims_order). The farm writes
# dims in DIMS order; assert column length only (order fixed by construction).
EXPECTED_DIM = 6


def _make_labels(record: dict) -> list[float]:
    fv = record["final_vector"]
    assert len(fv) == EXPECTED_DIM, f"final_vector len {len(fv)}"
    return [float(v) for v in fv]


def _hf_token() -> str | None:
    tok = os.environ.get("HF_TOKEN")
    if tok:
        return tok
    for p in ("/root/.hf_token_regolo", os.path.expanduser("~/.hf_token_regolo")):
        try:
            return open(p).read().strip()
        except OSError:
            continue
    return None


def build_train_val(tokenizer, max_length: int = 8192,
                    val_ratio: float = 0.1, seed: int = 42):
    """Load HF dataset, stratified split on disagreement, tokenize queries."""
    full = load_dataset(HF_REPO, data_files=HF_FILE, token=_hf_token())["train"]

    full = full.map(lambda r: {"labels": _make_labels(r)},
                    desc="building labels")
    full = full.map(lambda r: tokenizer(r["query"], truncation=True,
                                        max_length=max_length),
                    batched=True, desc="tokenizing")
    full = full.class_encode_column("disagreement")

    split = full.train_test_split(test_size=val_ratio, seed=seed,
                                  stratify_by_column="disagreement")
    keep = ["input_ids", "attention_mask", "labels"]
    train_ds = split["train"].remove_columns(
        [c for c in split["train"].column_names if c not in keep])
    val_ds = split["test"].remove_columns(
        [c for c in split["test"].column_names if c not in keep])
    return train_ds, val_ds
