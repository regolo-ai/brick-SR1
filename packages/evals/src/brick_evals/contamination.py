"""Contamination detection: 13-gram overlap LMSYS-style + canary GUID helpers."""

from __future__ import annotations

import re
import uuid
from collections import defaultdict


def normalize_for_ngram(text: str) -> str:
    text = text.lower()
    text = re.sub(r"\s+", " ", text)
    text = re.sub(r"[^\w\s]+", " ", text)
    return text.strip()


def ngrams(text: str, n: int = 13) -> set[str]:
    """Word-level n-grams. Default n=13 (LMSYS llm-decontaminator standard)."""
    words = normalize_for_ngram(text).split()
    if len(words) < n:
        return set()
    return {" ".join(words[i : i + n]) for i in range(len(words) - n + 1)}


def build_ngram_index(reference_texts: list[str], n: int = 13) -> dict[str, list[int]]:
    """Inverted index: ngram → list of reference indices containing it."""
    idx: dict[str, list[int]] = defaultdict(list)
    for ref_i, ref_text in enumerate(reference_texts):
        for g in ngrams(ref_text, n=n):
            idx[g].append(ref_i)
    return idx


def overlap_ratio(query_text: str, ngram_index: dict[str, list[int]], n: int = 13) -> float:
    """Fraction of query n-grams that appear in reference index."""
    q_ngrams = ngrams(query_text, n=n)
    if not q_ngrams:
        return 0.0
    hits = sum(1 for g in q_ngrams if g in ngram_index)
    return hits / len(q_ngrams)


def canary_guid() -> str:
    """Generate a random GUID for canary insertion in pretraining detection."""
    return f"CANARY-GUID-{uuid.uuid4()}"
