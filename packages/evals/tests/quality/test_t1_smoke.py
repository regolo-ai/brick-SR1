"""Smoke tests Tier 1: invariant checks on report json files."""

import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "src"))

from brick_evals.io_utils import data_dir

REPORTS = data_dir("reports", "quality")
EXPECTED = [
    "schema.json",
    "dedup_minhash.json",
    "dedup_embed.json",
    "tokenizer_drift.json",
    "encoding.json",
    "payload.json",
    "distribution.json",
    "contamination.json",
    "pii.json",
    "toxicity.json",
    "irt_proxy.json",
    "hub_roundtrip.json",
    "manifest.json",
]


@pytest.mark.parametrize("filename", EXPECTED)
def test_report_exists(filename):
    p = REPORTS / filename
    if not p.exists():
        pytest.skip(f"report {filename} not generated yet (run scripts/quality/run_all.py)")
    obj = json.loads(p.read_text())
    assert "status" in obj, f"{filename} missing status"
    assert obj["status"] in {"pass", "fail"}, f"{filename} unexpected status {obj['status']}"


def test_schema_pass():
    p = REPORTS / "schema.json"
    if not p.exists():
        pytest.skip()
    obj = json.loads(p.read_text())
    assert obj["status"] == "pass", f"schema validation failed: {obj.get('errors_sample')}"


def test_payload_typed_pass():
    p = REPORTS / "payload.json"
    if not p.exists():
        pytest.skip()
    obj = json.loads(p.read_text())
    assert obj["status"] == "pass", f"payload validation failed: {obj.get('errors_per_type')}"


def test_dedup_minhash_no_cross_source():
    p = REPORTS / "dedup_minhash.json"
    if not p.exists():
        pytest.skip()
    obj = json.loads(p.read_text())
    cs = obj.get("cross_source", {})
    assert cs.get("status") == "pass", f"cross-source duplicates: {cs}"


def test_dedup_embed_no_cross_source():
    p = REPORTS / "dedup_embed.json"
    if not p.exists():
        pytest.skip()
    obj = json.loads(p.read_text())
    cs = obj.get("cross_source", {})
    assert cs.get("status") == "pass", f"cross-source semantic duplicates: {cs}"


def test_tokenizer_drift_pass():
    p = REPORTS / "tokenizer_drift.json"
    if not p.exists():
        pytest.skip()
    obj = json.loads(p.read_text())
    assert obj["status"] == "pass", f"tokenizer drift: {obj.get('recompute_mismatch')}"


def test_distribution_sanity():
    p = REPORTS / "distribution.json"
    if not p.exists():
        pytest.skip()
    obj = json.loads(p.read_text())
    assert obj["status"] == "pass", f"distribution sanity: {obj.get('sanity_failures')}"


def test_hub_roundtrip_pass():
    p = REPORTS / "hub_roundtrip.json"
    if not p.exists():
        pytest.skip()
    obj = json.loads(p.read_text())
    assert obj["status"] == "pass", f"hub roundtrip: {obj.get('fails')}"
