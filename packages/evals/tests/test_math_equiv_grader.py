"""TDD test suite for math_equiv grader \text/mbox fix.

Run: python -m pytest tests/test_math_equiv_grader.py -v
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "scripts"))

import importlib.util

spec = importlib.util.spec_from_file_location("g110", Path(__file__).parent.parent / "scripts/110_grade_inference.py")
g110 = importlib.util.module_from_spec(spec)
spec.loader.exec_module(g110)

grade_math_equiv = g110.grade_math_equiv
_normalize_math = g110._normalize_math


def _grade(response: str, expected: str):
    """Helper: invoke grader come fa il dispatcher."""
    return grade_math_equiv(response, {"final_answer": expected})


# --- Regression: casi che già passano ---
def test_simple_number():
    ok, _ = _grade("\\boxed{117}", "117")
    assert ok is True


def test_simple_number_2():
    ok, _ = _grade("\\boxed{468}", "468")
    assert ok is True


def test_latex_frac_match():
    ok, _ = _grade("\\boxed{\\frac{1}{2}}", "\\frac{1}{2}")
    assert ok is True


def test_text_word_identical():
    ok, _ = _grade("\\boxed{\\text{Evelyn}}", "\\text{Evelyn}")
    assert ok is True


def test_text_word_ellipse():
    ok, _ = _grade("\\boxed{\\text{ellipse}}", "\\text{ellipse}")
    assert ok is True


def test_numeric_with_unit_suffix():
    """5.4 vs 5.4 \\text{ cents} → unit deve essere strippato"""
    ok, _ = _grade("\\boxed{5.4}", "5.4 \\text{ cents}")
    assert ok is True


# --- Fix targets: 8 row che attualmente falliscono ---
def test_case_insensitive_word():
    """q_03134: East ≡ \\text{east}"""
    ok, _ = _grade("\\boxed{East}", "\\text{east}")
    assert ok is True


def test_text_word_lowercase():
    """q_03157: even ≡ \\text{even}"""
    ok, _ = _grade("\\boxed{even}", "\\text{even}")
    assert ok is True


def test_frac_equiv_with_unit():
    """q_03203: \\frac{270}{7} ≡ \\frac{270}7\\text{ degrees} (numeric eq)"""
    ok, _ = _grade("\\boxed{\\frac{270}{7}}", "\\frac{270}7\\text{ degrees}")
    assert ok is True


def test_multichoice_paren_C():
    """q_03264: C ≡ \\text{(C)} (paren strip)"""
    ok, _ = _grade("\\boxed{C}", "\\text{(C)}")
    assert ok is True


def test_multichoice_paren_E():
    """q_03292: E ≡ \\text{(E)}"""
    ok, _ = _grade("\\boxed{E}", "\\text{(E)}")
    assert ok is True


def test_multichoice_paren_B():
    """q_03333: B ≡ \\text{(B)}"""
    ok, _ = _grade("\\boxed{B}", "\\text{(B)}")
    assert ok is True


def test_text_word_capital_Navin():
    """q_03435: Navin ≡ \\text{Navin}"""
    ok, _ = _grade("\\boxed{Navin}", "\\text{Navin}")
    assert ok is True


def test_mbox_unit_with_exponent_1():
    """q_03294: 864 ≡ 864 \\mbox{ inches}^2 (area unit)"""
    ok, _ = _grade("\\boxed{864}", "864 \\mbox{ inches}^2")
    assert ok is True


def test_mbox_unit_with_exponent_2():
    """q_03504: 15 ≡ 15\\mbox{ cm}^2"""
    ok, _ = _grade("\\boxed{15}", "15\\mbox{ cm}^2")
    assert ok is True


def test_degree_circ_suffix():
    """q_03044 spotted by audit: 90 ≡ 90^\\circ"""
    ok, _ = _grade("\\boxed{90}", "90^\\circ")
    assert ok is True


def test_degree_circ_braced():
    """variante: 90 ≡ 90^{\\circ}"""
    ok, _ = _grade("\\boxed{90}", "90^{\\circ}")
    assert ok is True


# --- Negative tests: NO false positives ---
def test_no_match_different_numbers():
    ok, _ = _grade("\\boxed{100}", "200")
    assert ok is False


def test_no_match_different_letters():
    ok, _ = _grade("\\boxed{A}", "\\text{(B)}")
    assert ok is False


def test_no_match_different_words():
    ok, _ = _grade("\\boxed{west}", "\\text{east}")
    assert ok is False


def test_no_match_partial():
    """'Evelyn' deve NON matchare 'Evelyn123'"""
    ok, _ = _grade("\\boxed{Evelyn}", "Evelyn123")
    assert ok is False


def test_no_match_different_frac():
    ok, _ = _grade("\\boxed{\\frac{1}{2}}", "\\frac{1}{3}")
    assert ok is False


def test_truncation_empty():
    """response vuota deve dare False (no candidate)"""
    ok, meta = _grade("", "5")
    assert ok is False
    assert "no boxed" in meta.get("reason", "")


# --- Edge cases ---
def test_no_boxed_explicit_final_answer():
    """fallback: pattern 'final answer: X' senza boxed (current grader supporta : delim)"""
    ok, _ = _grade("The final answer: 42.", "42")
    assert ok is True


def test_nested_boxed_qwen_pattern():
    """Qwen3.5 emette \\boxed{\\boxed{X}}: già fixed"""
    ok, _ = _grade("\\boxed{\\boxed{117}}", "117")
    assert ok is True


if __name__ == "__main__":
    import subprocess

    subprocess.run([sys.executable, "-m", "pytest", __file__, "-v"], check=False)
