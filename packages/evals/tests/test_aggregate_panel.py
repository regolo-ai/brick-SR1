"""Test scripts/115_aggregate_panel.py: majority vote 2/3 panel aggregation."""

from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest


@pytest.fixture(scope="module")
def agg():
    spec = importlib.util.spec_from_file_location(
        "agg115",
        Path(__file__).resolve().parents[1] / "scripts" / "115_aggregate_panel.py",
    )
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


# --- majority_vote --------------------------------------------------------


def test_vote_unanimous_accept(agg):
    assert agg.majority_vote([True, True, True]) == (True, "3-0")


def test_vote_unanimous_reject(agg):
    assert agg.majority_vote([False, False, False]) == (False, "0-3")


def test_vote_majority_accept_2_1(agg):
    assert agg.majority_vote([True, True, False]) == (True, "2-1")


def test_vote_majority_reject_1_2(agg):
    assert agg.majority_vote([True, False, False]) == (False, "1-2")


def test_vote_one_abstention_2_0(agg):
    assert agg.majority_vote([True, True, None]) == (True, "2-0")


def test_vote_one_abstention_tie_1_1(agg):
    # 1 accept, 1 reject, 1 abstention -> no resolvable majority -> None
    assert agg.majority_vote([True, False, None]) == (None, "1-1")


def test_vote_two_abstentions_insufficient(agg):
    # only 1 valid vote -> insufficient panel coverage -> None
    assert agg.majority_vote([True, None, None]) == (None, "1-0")


def test_vote_all_abstention(agg):
    assert agg.majority_vote([None, None, None]) == (None, "0-0")


# --- aggregate_row --------------------------------------------------------


def _judge_row(qid, proto, correct, decision, cost, model):
    return {
        "query_id": qid,
        "evaluation_protocol_id": proto,
        "dimension": "planning_agentic",
        "correct": correct,
        "grader_meta": {
            "judge_model": model,
            "judge_decision": decision,
            "judge_raw_response": f"Decision: {decision}",
            "judge_cost_usd": cost,
        },
    }


def test_aggregate_judge_row_majority(agg):
    rows = {
        "openai/gpt-5.4-mini": _judge_row("q1", "rubric_judge", True, "accept", 0.0019, "openai/gpt-5.4-mini"),
        "mistralai/mistral-small-2603": _judge_row(
            "q1", "rubric_judge", True, "accept", 0.0003, "mistralai/mistral-small-2603"
        ),
        "z-ai/glm-5-turbo": _judge_row("q1", "rubric_judge", False, "reject", 0.0026, "z-ai/glm-5-turbo"),
    }
    out = agg.aggregate_row("q1", rows)
    assert out["correct"] is True
    assert out["panel_vote"] == "2-1"
    assert set(out["panel"].keys()) == set(rows.keys())
    assert out["panel"]["z-ai/glm-5-turbo"]["decision"] == "reject"
    assert abs(out["panel_cost_usd"] - (0.0019 + 0.0003 + 0.0026)) < 1e-9
    # base fields preserved
    assert out["query_id"] == "q1"
    assert out["evaluation_protocol_id"] == "rubric_judge"


def test_aggregate_passthrough_non_judge_row(agg):
    # tool_call_match graded deterministically: identical across files, pass through
    base = {
        "query_id": "q2",
        "evaluation_protocol_id": "tool_call_match",
        "dimension": "planning_agentic",
        "correct": True,
        "grader_meta": {"category": "simple", "checker_error": []},
    }
    rows = {m: dict(base) for m in ("openai/gpt-5.4-mini", "mistralai/mistral-small-2603", "z-ai/glm-5-turbo")}
    out = agg.aggregate_row("q2", rows)
    assert out["correct"] is True
    assert "panel" not in out  # no panel for deterministic rows
    assert out["evaluation_protocol_id"] == "tool_call_match"


def test_aggregate_missing_judge_treated_as_abstention(agg):
    # query_id present in only 2 of 3 files -> third judge is an abstention
    rows = {
        "openai/gpt-5.4-mini": _judge_row("q3", "rubric_judge", True, "accept", 0.002, "openai/gpt-5.4-mini"),
        "mistralai/mistral-small-2603": _judge_row(
            "q3", "rubric_judge", True, "accept", 0.0003, "mistralai/mistral-small-2603"
        ),
        # z-ai/glm-5-turbo missing
    }
    out = agg.aggregate_row("q3", rows)
    assert out["correct"] is True
    assert out["panel_vote"] == "2-0"
