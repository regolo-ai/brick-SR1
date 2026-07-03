"""Test 120_run_bfcl_multi_turn helpers: parsing e tool catalog."""

from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest


@pytest.fixture(scope="module")
def runner():
    spec = importlib.util.spec_from_file_location(
        "run120",
        Path(__file__).resolve().parents[1] / "scripts" / "120_run_bfcl_multi_turn.py",
    )
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def test_parse_done(runner):
    calls, mode = runner._parse_model_response("DONE")
    assert calls is None
    assert mode == "DONE"


def test_parse_done_with_spaces(runner):
    calls, mode = runner._parse_model_response("   done   ")
    assert mode == "DONE"


def test_parse_empty(runner):
    calls, mode = runner._parse_model_response("")
    assert calls is None
    assert mode == "none"


def test_parse_single_call(runner):
    calls, mode = runner._parse_model_response("cd(folder='document')")
    assert mode == "calls"
    assert calls == ["cd(folder='document')"]


def test_parse_multiple_calls_list(runner):
    calls, mode = runner._parse_model_response("[cd(folder='doc'), mkdir(dir_name='temp')]")
    assert mode == "calls"
    assert calls == ["cd(folder='doc')", "mkdir(dir_name='temp')"]


def test_parse_prose_only(runner):
    """Plain text senza call -> mode none."""
    calls, mode = runner._parse_model_response("I think we should start by checking the file system.")
    assert calls is None
    assert mode == "none"


def test_parse_python_code_block(runner):
    txt = "```python\ncd(folder='temp')\n```"
    calls, mode = runner._parse_model_response(txt)
    assert mode == "calls"
    assert calls == ["cd(folder='temp')"]


def test_tool_catalog_for_gorilla_filesystem(runner):
    catalog = runner._build_tool_catalog(["GorillaFileSystem"])
    assert "GorillaFileSystem" in catalog
    # Sappiamo che esistono cd, mkdir, mv, ecc. (dal sample task)
    assert "cd" in catalog
    assert "mkdir" in catalog


def test_tool_catalog_multi_class(runner):
    catalog = runner._build_tool_catalog(["GorillaFileSystem", "TwitterAPI"])
    assert "GorillaFileSystem" in catalog
    assert "TwitterAPI" in catalog
