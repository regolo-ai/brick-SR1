"""Test build_messages_for_row in 100_run_inference: distingue BFCL vs altri."""

from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest


@pytest.fixture(scope="module")
def runner():
    """Carica 100_run_inference.py come modulo (nome inizia con cifra → no import)."""
    spec = importlib.util.spec_from_file_location(
        "run100", Path(__file__).resolve().parents[1] / "scripts" / "100_run_inference.py"
    )
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def test_build_messages_default_non_agentic(runner):
    row = {"query": "What is 2+2?", "evaluation_protocol_id": "gsm8k_final_answer"}
    msgs = runner.build_messages_for_row(row)
    assert msgs == [{"role": "user", "content": "What is 2+2?"}]


def test_build_messages_bfcl_includes_system_with_functions(runner):
    row = {
        "query": "Get the weather in Paris.",
        "evaluation_protocol_id": "tool_call_match",
        "expected_answer": {
            "payload": {
                "function_specs": [
                    {"name": "get_weather", "parameters": {"type": "dict", "properties": {"city": {"type": "string"}}}}
                ],
                "category": "simple",
            }
        },
    }
    msgs = runner.build_messages_for_row(row)
    assert len(msgs) == 2
    assert msgs[0]["role"] == "system"
    assert "get_weather" in msgs[0]["content"]
    # Anche il formato di output deve essere documentato nel system prompt
    assert "function_name(arg1=value1" in msgs[0]["content"]
    assert msgs[1] == {"role": "user", "content": "Get the weather in Paris."}


def test_build_messages_bfcl_irrelevance_format_documented(runner):
    """L'output `[]` per irrelevance deve essere esplicitamente menzionato."""
    row = {
        "query": "Tell me a joke.",
        "evaluation_protocol_id": "tool_call_match",
        "expected_answer": {
            "payload": {
                "function_specs": [{"name": "f", "parameters": {}}],
                "category": "irrelevance",
            }
        },
    }
    msgs = runner.build_messages_for_row(row)
    assert "[]" in msgs[0]["content"]


def test_build_messages_bfcl_missing_payload_fallback(runner):
    """Se manca function_specs, il system viene comunque costruito (lista vuota)."""
    row = {
        "query": "Anything",
        "evaluation_protocol_id": "tool_call_match",
        "expected_answer": {},
    }
    msgs = runner.build_messages_for_row(row)
    assert msgs[0]["role"] == "system"
    # JSON [] presente nel system
    assert "[]" in msgs[0]["content"]


def test_build_messages_rubric_judge_uses_default(runner):
    """rubric_judge (Planning-Custom) NON aggiunge system prompt: query plain."""
    row = {
        "query": "Plan a 3-day trip under $500.",
        "evaluation_protocol_id": "rubric_judge",
        "expected_answer": {"payload": {"rubric_id": "planning_custom_rubric"}},
    }
    msgs = runner.build_messages_for_row(row)
    assert len(msgs) == 1
    assert msgs[0]["role"] == "user"
