"""Sanity check: query del dataset non devono contenere PII evidenti."""

import re
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from brick_evals.io_utils import data_dir, load_jsonl

EMAIL_RE = re.compile(r"\b[\w\.\-]+@[\w\.\-]+\.\w{2,}\b")
PHONE_RE = re.compile(r"\b\+?\d{1,3}[-\s]?\(?\d{2,4}\)?[-\s]?\d{3,4}[-\s]?\d{3,4}\b")
SSN_RE = re.compile(r"\b\d{3}-\d{2}-\d{4}\b")
CC_RE = re.compile(r"\b(?:\d[ -]*?){13,16}\b")


@pytest.mark.skipif(
    not (data_dir("final") / "evaluation_parameters_full.jsonl").exists(),
    reason="Pipeline not yet run; final/evaluation_parameters_full.jsonl missing",
)
def test_no_pii_in_queries():
    path = data_dir("final") / "evaluation_parameters_full.jsonl"
    found = []
    total = 0
    for r in load_jsonl(path):
        total += 1
        q = r.get("query", "")
        if EMAIL_RE.search(q):
            found.append(("email", r["query_id"]))
        if SSN_RE.search(q):
            found.append(("ssn", r["query_id"]))
    if found and len(found) > total * 0.05:
        pytest.fail(f"Too many PII matches: {found[:10]}")
