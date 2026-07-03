"""Test bfcl_grader (single-turn).

Test minimi per le 5 categorie BFCL + parsing response.
"""

from __future__ import annotations

import pytest
from brick_evals.graders.bfcl_grader import (
    AVAILABLE,
    extract_calls,
    grade_bfcl,
)

pytestmark = pytest.mark.skipif(not AVAILABLE, reason="BFCL ast_checker not importable")


# --- Helpers per costruire payload BFCL minimali --------------------------


def _func_spec_simple() -> dict:
    return {
        "name": "calculate_cell_density",
        "description": "Calculate cell density.",
        "parameters": {
            "type": "dict",
            "properties": {
                "optical_density": {"type": "float", "description": "OD"},
                "dilution": {"type": "integer", "description": "Dilution"},
                "calibration_factor": {"type": "float", "description": "Calibration"},
            },
            "required": ["optical_density", "dilution"],
        },
    }


def _payload_simple() -> dict:
    return {
        "id": "simple_57",
        "category": "simple",
        "function_specs": [_func_spec_simple()],
        "ground_truth_calls": [
            {
                "calculate_cell_density": {
                    "optical_density": [0.6],
                    "dilution": [5],
                    "calibration_factor": ["", 1e9],
                }
            }
        ],
    }


def _payload_irrelevance() -> dict:
    return {
        "id": "irrelevance_3",
        "category": "irrelevance",
        "function_specs": [_func_spec_simple()],
        "ground_truth_calls": [],
    }


# --- Parsing tests --------------------------------------------------------


def test_extract_calls_raw_python():
    calls, meta = extract_calls("calculate_cell_density(optical_density=0.6, dilution=5)")
    assert calls == [{"calculate_cell_density": {"optical_density": 0.6, "dilution": 5}}]
    assert meta["strategy"] == "raw_python"


def test_extract_calls_python_code_block():
    txt = "Sure, here's the call:\n" "```python\n" "calculate_cell_density(optical_density=0.6, dilution=5)\n" "```\n"
    calls, meta = extract_calls(txt)
    assert calls == [{"calculate_cell_density": {"optical_density": 0.6, "dilution": 5}}]
    assert meta["strategy"] == "py_block"


def test_extract_calls_toolcall_tag():
    txt = "<TOOLCALL>[calculate_cell_density(optical_density=0.6, dilution=5)]</TOOLCALL>"
    calls, meta = extract_calls(txt)
    assert calls == [{"calculate_cell_density": {"optical_density": 0.6, "dilution": 5}}]
    assert meta["strategy"] == "toolcall_tag_python"


def test_extract_calls_openai_json_block():
    txt = (
        "```json\n" '[{"name": "calculate_cell_density", "arguments": {"optical_density": 0.6, "dilution": 5}}]\n' "```"
    )
    calls, meta = extract_calls(txt)
    assert calls == [{"calculate_cell_density": {"optical_density": 0.6, "dilution": 5}}]
    assert meta["strategy"] == "json_block_openai"


def test_extract_calls_empty_response():
    calls, meta = extract_calls("")
    assert calls is None
    assert "empty" in meta["reason"].lower()


def test_extract_calls_unparseable():
    calls, meta = extract_calls("I cannot answer that question.")
    assert calls is None


# --- Grading tests --------------------------------------------------------


def test_grade_simple_correct():
    response = "calculate_cell_density(optical_density=0.6, dilution=5)"
    correct, meta = grade_bfcl(response, _payload_simple())
    assert correct is True, meta


def test_grade_simple_wrong_value():
    response = "calculate_cell_density(optical_density=0.6, dilution=10)"  # dilution sbagliato
    correct, meta = grade_bfcl(response, _payload_simple())
    assert correct is False


def test_grade_simple_with_optional_param():
    # calibration_factor accetta "" o 1e9 -> ometterlo è ok perché "" è nella lista
    response = "calculate_cell_density(optical_density=0.6, dilution=5)"
    correct, _ = grade_bfcl(response, _payload_simple())
    assert correct is True


def test_grade_irrelevance_no_call():
    response = "I cannot help with that request."
    correct, meta = grade_bfcl(response, _payload_irrelevance())
    assert correct is True
    assert meta["decoded_n"] == 0


def test_grade_irrelevance_with_unwanted_call():
    response = "calculate_cell_density(optical_density=0.6, dilution=5)"
    correct, meta = grade_bfcl(response, _payload_irrelevance())
    assert correct is False
    assert meta["decoded_n"] == 1


def test_grade_simple_no_response():
    correct, meta = grade_bfcl("", _payload_simple())
    assert correct is False
    assert "no tool call" in meta["reason"]


def test_grade_simple_openai_format():
    response = (
        "```json\n" '[{"name": "calculate_cell_density", "arguments": {"optical_density": 0.6, "dilution": 5}}]\n' "```"
    )
    correct, _ = grade_bfcl(response, _payload_simple())
    assert correct is True
