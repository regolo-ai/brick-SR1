"""Test deterministic_hash stabilità cross-run."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from brick_evals.io_utils import deterministic_hash


def test_string_stable():
    assert deterministic_hash("hello") == deterministic_hash("hello")


def test_dict_order_invariant():
    a = {"x": 1, "y": 2}
    b = {"y": 2, "x": 1}
    assert deterministic_hash(a) == deterministic_hash(b)


def test_unicode_stable():
    s = "ciao caffè ❤️ 北京"
    h1 = deterministic_hash(s)
    h2 = deterministic_hash(s)
    assert h1 == h2
    assert len(h1) == 16


def test_different_inputs_differ():
    assert deterministic_hash("a") != deterministic_hash("b")
