"""Test schema validation."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from brick_evals.schema import validate_row


def _good_row():
    return {
        "query_id": "q_00001",
        "query": "What is 2+2?",
        "dimension": "math_reasoning",
        "source": "GSM8K",
        "shots": 5,
        "input_tokens_qwen": 10,
        "input_tokens_deepseek": 10,
        "input_tokens_kimi": 10,
        "expected_answer": {"type": "exact_match", "payload": {"final_answer": "4"}},
        "few_shot_examples": [],
        "evaluation_protocol_id": "gsm8k_final_answer",
        "gated": False,
        "license": "mit",
        "length_band": "short",
    }


def test_good_row_passes():
    assert validate_row(_good_row()) == []


def test_invalid_dimension():
    r = _good_row()
    r["dimension"] = "wrong"
    errs = validate_row(r)
    assert any("invalid dimension" in e for e in errs)


def test_missing_field():
    r = _good_row()
    del r["query_id"]
    errs = validate_row(r)
    assert any("missing" in e for e in errs)


def test_invalid_query_id():
    r = _good_row()
    r["query_id"] = "bad"
    errs = validate_row(r)
    assert any("query_id" in e for e in errs)


def test_invalid_expected_type():
    r = _good_row()
    r["expected_answer"] = {"type": "weird", "payload": {}}
    errs = validate_row(r)
    assert any("invalid expected_answer.type" in e for e in errs)


def test_gated_unmasked_strict():
    r = _good_row()
    r["gated"] = True
    errs = validate_row(r, allow_unmasked_token_count=False)
    assert any("masked" in e for e in errs)
