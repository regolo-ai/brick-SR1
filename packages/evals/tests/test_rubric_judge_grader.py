"""Test rubric_judge_grader con mock judge client.

`grade_rubric` è async (usa OpenRouterJudgeClient async). I test la invocano via
`asyncio.run(...)` per non dipendere da `pytest-asyncio`.
"""

from __future__ import annotations

import asyncio

import pytest
from brick_evals.graders.rubric_judge_grader import (
    AVAILABLE,
    get_rubric,
    grade_rubric,
    parse_decision,
)

pytestmark = pytest.mark.skipif(not AVAILABLE, reason="rubric_judge dependencies missing")


# --- Mock judge client ----------------------------------------------------


class _MockJudge:
    def __init__(self, output: str):
        self.output = output
        self.calls: list[dict] = []

    async def chat(self, messages, **kwargs):
        self.calls.append({"messages": messages, "kwargs": kwargs})
        return {"choices": [{"message": {"content": self.output}}], "usage": {}}


# --- parse_decision -------------------------------------------------------


def test_parse_decision_accept():
    assert parse_decision("Reasoning: looks good.\nDecision: accept") == "accept"


def test_parse_decision_reject():
    assert parse_decision("Reasoning: misses constraint.\nDecision: reject") == "reject"


def test_parse_decision_case_insensitive():
    assert parse_decision("DECISION: ACCEPT") == "accept"


def test_parse_decision_with_punctuation():
    assert parse_decision("decision : accept.") == "accept"


def test_parse_decision_takes_last():
    txt = "Decision: accept\n... reconsidered ...\nDecision: reject"
    assert parse_decision(txt) == "reject"


def test_parse_decision_none():
    assert parse_decision("the plan is fine") is None


def test_parse_decision_fallback_last_line():
    assert parse_decision("Stuff stuff stuff.\naccept") == "accept"


# --- get_rubric -----------------------------------------------------------


def test_get_rubric_builtin_planning():
    r = get_rubric("planning_custom_rubric")
    assert r is not None
    assert "PLANNING" in r.upper()


def test_get_rubric_unknown_returns_none():
    assert get_rubric("nonexistent_rubric") is None


# --- grade_rubric (async) -------------------------------------------------


def _payload_planning() -> dict:
    return {"rubric_id": "planning_custom_rubric", "category": "travel-planning"}


def test_grade_rubric_accept():
    judge = _MockJudge("Reasoning: solid plan.\nDecision: accept")
    correct, meta = asyncio.run(
        grade_rubric(
            response="Step 1...Step 2...Step 3...",
            payload=_payload_planning(),
            query="Plan a 3-day trip under $500.",
            judge_client=judge,
        )
    )
    assert correct is True
    assert meta["judge_decision"] == "accept"
    assert len(judge.calls) == 1


def test_grade_rubric_reject():
    judge = _MockJudge("Reasoning: too vague.\nDecision: reject")
    correct, _ = asyncio.run(
        grade_rubric(
            response="Just go to Paris.",
            payload=_payload_planning(),
            query="Plan a 3-day trip under $500.",
            judge_client=judge,
        )
    )
    assert correct is False


def test_grade_rubric_missing_query():
    judge = _MockJudge("Decision: accept")
    correct, meta = asyncio.run(
        grade_rubric(
            response="A response",
            payload=_payload_planning(),
            query="",
            judge_client=judge,
        )
    )
    assert correct is None
    assert "missing query" in meta["reason"]
    assert len(judge.calls) == 0


def test_grade_rubric_unknown_rubric_id():
    judge = _MockJudge("Decision: accept")
    correct, meta = asyncio.run(
        grade_rubric(
            response="x",
            payload={"rubric_id": "no_such_rubric"},
            query="Anything",
            judge_client=judge,
        )
    )
    assert correct is None
    assert "unknown rubric_id" in meta["reason"]


def test_grade_rubric_missing_rubric_id():
    judge = _MockJudge("Decision: accept")
    correct, meta = asyncio.run(
        grade_rubric(
            response="x",
            payload={},
            query="Anything",
            judge_client=judge,
        )
    )
    assert correct is None
    assert "missing rubric_id" in meta["reason"]


def test_grade_rubric_empty_response():
    judge = _MockJudge("Decision: accept")
    correct, meta = asyncio.run(
        grade_rubric(
            response="",
            payload=_payload_planning(),
            query="Plan something.",
            judge_client=judge,
        )
    )
    assert correct is False
    assert "empty response" in meta["reason"]


def test_grade_rubric_judge_no_decision():
    judge = _MockJudge("This plan is fine, no issues.")
    correct, meta = asyncio.run(
        grade_rubric(
            response="A response",
            payload=_payload_planning(),
            query="Plan a trip.",
            judge_client=judge,
        )
    )
    assert correct is None
    assert "did not contain Decision" in meta["reason"]


def test_grade_rubric_judge_error():
    class _BoomJudge:
        async def chat(self, messages, **kwargs):
            raise RuntimeError("boom")

    correct, meta = asyncio.run(
        grade_rubric(
            response="A response",
            payload=_payload_planning(),
            query="Plan a trip.",
            judge_client=_BoomJudge(),
        )
    )
    assert correct is None
    assert "judge call failed" in meta["reason"]
    assert "RuntimeError" in meta["error"]


def test_grade_rubric_includes_query_in_judge_prompt():
    judge = _MockJudge("Decision: accept")
    asyncio.run(
        grade_rubric(
            response="plan",
            payload=_payload_planning(),
            query="UNIQUE_QUERY_MARKER_42",
            judge_client=judge,
        )
    )
    user_msg = judge.calls[0]["messages"][1]["content"]
    assert "UNIQUE_QUERY_MARKER_42" in user_msg


def test_grade_rubric_includes_response_in_judge_prompt():
    judge = _MockJudge("Decision: accept")
    asyncio.run(
        grade_rubric(
            response="UNIQUE_RESPONSE_MARKER_99",
            payload=_payload_planning(),
            query="plan",
            judge_client=judge,
        )
    )
    user_msg = judge.calls[0]["messages"][1]["content"]
    assert "UNIQUE_RESPONSE_MARKER_99" in user_msg


# --- judge cost (per-model pricing) ---------------------------------------


def test_judge_cost_mistral():
    from brick_evals.graders.rubric_judge_grader import _judge_cost

    # 1M in + 1M out at $0.15 / $0.60
    assert abs(_judge_cost("mistralai/mistral-small-2603", 1_000_000, 1_000_000) - 0.75) < 1e-9


def test_judge_cost_gpt():
    from brick_evals.graders.rubric_judge_grader import _judge_cost

    assert abs(_judge_cost("openai/gpt-5.4-mini", 1_000_000, 1_000_000) - 5.25) < 1e-9


def test_judge_cost_glm():
    from brick_evals.graders.rubric_judge_grader import _judge_cost

    assert abs(_judge_cost("z-ai/glm-5-turbo", 1_000_000, 1_000_000) - 5.20) < 1e-9


def test_judge_cost_unknown_model_fallback():
    from brick_evals.graders.rubric_judge_grader import _judge_cost

    # unknown model → falls back to gpt-5.4-mini pricing (documented default), never crashes
    assert _judge_cost("some/unknown-model", 1_000_000, 1_000_000) == 5.25


# --- judge max_tokens headroom --------------------------------------------


def test_grade_rubric_requests_adequate_max_tokens():
    # Verbose / reasoning judges (GLM) need headroom to reach the `Decision:` line.
    # 512 truncates GLM mid-reasoning -> unparseable. Require >= 1024.
    judge = _MockJudge("Decision: accept")
    asyncio.run(
        grade_rubric(
            response="plan",
            payload=_payload_planning(),
            query="q",
            judge_client=judge,
        )
    )
    assert judge.calls[0]["kwargs"]["max_tokens"] >= 1024
