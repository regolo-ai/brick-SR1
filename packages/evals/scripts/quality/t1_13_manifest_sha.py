#!/usr/bin/env python3
"""T1-13: Manifest SHA256 + Croissant metadata + HF revision pin.

Genera:
- data/reports/quality/manifest.json: SHA256 dei file finali (jsonl, masked, dataset_card.md, lockfile)
- HF revision SHA latest commit per dataset.
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "src"))

from brick_evals.io_utils import data_dir, file_sha256, hf_token, repo_root, utc_now_iso

REPO_ID = "massaindustries/dataset-A-routing-eval"


def main():
    files = {
        "evaluation_parameters_full.jsonl": data_dir("final") / "evaluation_parameters_full.jsonl",
        "evaluation_parameters_masked.jsonl": data_dir("final") / "evaluation_parameters_masked.jsonl",
        "dataset_card.md": data_dir("final") / "dataset_card.md",
        "lockfile.yaml": data_dir("reports") / "lockfile.yaml",
    }
    report_files = {}
    for name, p in files.items():
        if p.exists():
            report_files[name] = {
                "path": str(p.relative_to(repo_root())),
                "size_bytes": p.stat().st_size,
                "sha256": file_sha256(p),
            }
        else:
            report_files[name] = {"path": str(p.relative_to(repo_root())), "missing": True}

    # HF revision pin
    hf_revision = None
    hf_error = None
    try:
        os.environ["HF_TOKEN"] = hf_token()
        from huggingface_hub import HfApi

        api = HfApi(token=hf_token())
        info = api.dataset_info(REPO_ID)
        hf_revision = info.sha
    except Exception as e:
        hf_error = f"{type(e).__name__}: {str(e)[:200]}"

    report = {
        "check": "manifest_sha",
        "files": report_files,
        "hf": {"repo_id": REPO_ID, "revision_sha": hf_revision, "error": hf_error},
        "generated_at": utc_now_iso(),
        "status": "pass" if all(not v.get("missing") for v in report_files.values()) and hf_revision else "fail",
    }

    out_path = data_dir("reports", "quality") / "manifest.json"
    out_path.write_text(json.dumps(report, indent=2, ensure_ascii=False))
    print(f"[t1_13_manifest_sha] {report['status']} | hf_rev={hf_revision} → {out_path}")
    sys.exit(0 if report["status"] == "pass" else 1)


if __name__ == "__main__":
    main()
