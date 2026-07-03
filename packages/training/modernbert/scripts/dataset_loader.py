"""Dataset loading + tokenization + stratified split for ModernBERT training.

Loads massaindustries/dataset-B-modernbert-train from HF Hub, concats
`train` + `disagreement_review` splits into a unified 49,990-row dataset,
stratifies 90/10 train/val on the `disagreement` bool, tokenizes queries,
builds float label tensors of shape (6,) per record.

Public API:
    build_train_val(tokenizer, max_length=512, val_ratio=0.1, seed=42) -> (train_ds, val_ds)
    build_human_eval(tokenizer, max_length=512, csv_path=...) -> Dataset
"""

from __future__ import annotations

import csv
from pathlib import Path

from datasets import Dataset, concatenate_datasets, load_dataset

DIMS = [
    "instruction_following",
    "coding",
    "math_reasoning",
    "world_knowledge",
    "planning_agentic",
    "creative_synthesis",
]

HF_REPO = "massaindustries/dataset-B-modernbert-train"


def _make_labels(record: dict) -> list[float]:
    sf = record["scores_final"]
    return [float(sf[d]) for d in DIMS]


def build_train_val(tokenizer, max_length: int = 512, val_ratio: float = 0.1, seed: int = 42):
    """Load HF dataset, concat train+disagreement_review, stratified split."""
    ds = load_dataset(HF_REPO)
    full = concatenate_datasets([ds["train"], ds["disagreement_review"]])

    full = full.map(lambda r: {"labels": _make_labels(r)}, desc="building labels")
    full = full.map(
        lambda r: tokenizer(r["query"], truncation=True, max_length=max_length), batched=True, desc="tokenizing"
    )
    full = full.class_encode_column("disagreement")

    split = full.train_test_split(test_size=val_ratio, seed=seed, stratify_by_column="disagreement")
    keep = ["input_ids", "attention_mask", "labels"]
    train_ds = split["train"].remove_columns([c for c in split["train"].column_names if c not in keep])
    val_ds = split["test"].remove_columns([c for c in split["test"].column_names if c not in keep])
    return train_ds, val_ds


def build_human_eval(tokenizer, max_length: int = 512, csv_path: str | Path | None = None) -> Dataset:
    """Load human_eval CSV (Claude-annotated 200 samples) for held-out test."""
    if csv_path is None:
        csv_path = Path(__file__).resolve().parent.parent.parent / "data" / "human_eval" / "sample_200_filled.csv"
    rows = []
    with open(csv_path) as f:
        for r in csv.DictReader(f):
            rows.append(
                {
                    "query_id": r["query_id"],
                    "query": r["query"],
                    "labels": [float(r[d]) for d in DIMS],
                }
            )
    ds = Dataset.from_list(rows)
    ds = ds.map(
        lambda r: tokenizer(r["query"], truncation=True, max_length=max_length),
        batched=True,
        desc="tokenizing human_eval",
    )
    keep = ["input_ids", "attention_mask", "labels"]
    return ds.remove_columns([c for c in ds.column_names if c not in keep])
