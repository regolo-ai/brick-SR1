"""Unit tests per helper modules: judge, dedup, contamination."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "src"))

from brick_evals.contamination import build_ngram_index, ngrams, overlap_ratio
from brick_evals.dedup import (
    extract_actual_query,
    minhash_signature,
    normalize_text,
    shingles,
)
from brick_evals.judge import majority_vote, parse_json_object, parse_score_rubric


def test_majority_vote():
    assert majority_vote(["pass", "pass", "fail"]) == "pass"
    assert majority_vote(["fail", "fail", "fail"]) == "fail"
    assert majority_vote(["pass", "fail"]) == "ambiguous"
    assert majority_vote([]) == "ambiguous"


def test_parse_json_object():
    assert parse_json_object('{"a": 1}') == {"a": 1}
    assert parse_json_object('```json\n{"a": 2}\n```') == {"a": 2}
    assert parse_json_object("garbage") is None
    assert parse_json_object('Sì\n{"x": "y"}\nfine') == {"x": "y"}


def test_parse_score_rubric():
    text = '{"format":4, "cot_validity":5, "answer_alignment":4, "hallucination_inverse":5, "sufficiency":3, "verdict":"pass", "rationale":"ok"}'
    axes = ["format", "cot_validity", "answer_alignment", "hallucination_inverse", "sufficiency"]
    r = parse_score_rubric(text, axes)
    assert r is not None
    assert r["format"] == 4
    assert r["verdict"] == "pass"


def test_normalize_text_and_shingles():
    # punctuation collapses to space (intentional, kept simple) → double space possible
    out = normalize_text("Hello, World!  ")
    assert "hello" in out and "world" in out
    s = shingles("the quick brown fox jumps over lazy dog", n=3)
    assert "the quick brown" in s
    assert "lazy dog" not in s


def test_extract_actual_query():
    q = "Esempio 1: ...\n\nEsempio 2: ...\n\nProblema: 2+2=?\nSoluzione:"
    assert "2+2=?" in extract_actual_query(q)
    # No marker → tail
    short = "no marker " * 100
    out = extract_actual_query(short, max_tail_chars=50)
    assert len(out) <= 50


def test_minhash_jaccard():
    m1 = minhash_signature("the quick brown fox jumps")
    m2 = minhash_signature("the quick brown fox jumps")
    m3 = minhash_signature("totally unrelated content here please")
    j_eq = m1.jaccard(m2)
    j_diff = m1.jaccard(m3)
    assert j_eq > 0.9
    assert j_diff < 0.3


def test_ngrams():
    g = ngrams("a b c d e f g h i j k l m n", n=13)
    assert len(g) == 2  # 14 - 13 + 1
    assert "a b c d e f g h i j k l m" in g


def test_overlap_ratio():
    refs = ["the cat sat on the mat and looked outside the window today happily"]
    idx = build_ngram_index(refs, n=13)
    full_overlap_query = "the cat sat on the mat and looked outside the window today happily"
    no_overlap_query = "completely different sentence with no shared words at all between them whatsoever"
    assert overlap_ratio(full_overlap_query, idx, n=13) == 1.0
    assert overlap_ratio(no_overlap_query, idx, n=13) == 0.0
