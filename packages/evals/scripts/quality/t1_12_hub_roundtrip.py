#!/usr/bin/env python3
"""T1-12: HuggingFace Hub round-trip verification.

Carica `massaindustries/dataset-A-routing-eval` da HF Hub, verifica:
- schema 14-col match (rev.3)
- row count match local
- sample 50 rows: query_id format, expected_answer parse
- gated rows hanno query='<masked>'
"""

from __future__ import annotations

import json
import os
import random
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "src"))

from brick_evals.io_utils import data_dir, hf_token, load_jsonl
from brick_evals.schema import REQUIRED_FIELDS

REPO_ID = "massaindustries/dataset-A-routing-eval"
SAMPLE_N = 50


def main():
    from datasets import load_dataset

    os.environ["HF_TOKEN"] = hf_token()

    print(f"[t1_12_hub_roundtrip] loading {REPO_ID} from HF Hub...")
    try:
        ds = load_dataset(REPO_ID, split="train")
    except Exception as e:
        report = {
            "check": "hub_roundtrip",
            "status": "fail",
            "error": f"{type(e).__name__}: {str(e)[:300]}",
        }
        out_path = data_dir("reports", "quality") / "hub_roundtrip.json"
        out_path.write_text(json.dumps(report, indent=2))
        print(f"[t1_12_hub_roundtrip] fail | {e} → {out_path}")
        sys.exit(1)

    n_hub = len(ds)
    cols_hub = set(ds.column_names)

    # Compare with local masked
    local = list(load_jsonl(data_dir("final") / "evaluation_parameters_masked.jsonl"))
    n_local = len(local)

    fails = []
    if cols_hub != REQUIRED_FIELDS:
        missing = REQUIRED_FIELDS - cols_hub
        extra = cols_hub - REQUIRED_FIELDS
        fails.append(f"schema mismatch: missing={sorted(missing)} extra={sorted(extra)}")

    if n_hub != n_local:
        fails.append(f"row count mismatch: hub={n_hub} local={n_local}")

    # Sample inspection
    random.seed(42)
    idxs = random.sample(range(n_hub), min(SAMPLE_N, n_hub))
    sample_issues = []
    for i in idxs:
        row = ds[i]
        qid = row["query_id"]
        if not (qid.startswith("q_") and len(qid) == 7):
            sample_issues.append(f"bad query_id format: {qid}")
        # expected_answer is JSON-encoded string in arrow
        ea_str = row["expected_answer"]
        try:
            ea = json.loads(ea_str) if isinstance(ea_str, str) else ea_str
            if "type" not in ea or "payload" not in ea:
                sample_issues.append(f"{qid}: expected_answer missing keys")
        except json.JSONDecodeError:
            sample_issues.append(f"{qid}: expected_answer not parseable")
        # gated rows must be masked
        if row["gated"] and row["query"] != "<masked>":
            sample_issues.append(f"{qid}: gated but query not masked")

    if sample_issues:
        fails.append(f"sample_issues: {len(sample_issues)} (e.g., {sample_issues[:3]})")

    status = "pass" if not fails else "fail"

    report = {
        "check": "hub_roundtrip",
        "repo_id": REPO_ID,
        "n_hub": n_hub,
        "n_local": n_local,
        "columns_hub": sorted(cols_hub),
        "fails": fails,
        "n_sampled": len(idxs),
        "n_sample_issues": len(sample_issues),
        "sample_issues_preview": sample_issues[:10],
        "threshold_production": "schema match + row count match + 0 sample issues",
        "status": status,
    }

    out_path = data_dir("reports", "quality") / "hub_roundtrip.json"
    out_path.write_text(json.dumps(report, indent=2, ensure_ascii=False))
    print(f"[t1_12_hub_roundtrip] {status} | hub={n_hub} local={n_local} fails={fails} → {out_path}")
    sys.exit(0 if status == "pass" else 1)


if __name__ == "__main__":
    main()
