#!/usr/bin/env python3
"""T1-01: Schema rev.3 validation (14 colonne).

Sostituisce 80_verify_dataset.py rotto. Usa schema.validate_row + pydantic v2 typed.
Output: data/reports/quality/schema.json {n_rows, n_errors, errors[:50], status}.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "src"))

from brick_evals.io_utils import data_dir, load_jsonl
from brick_evals.schema import REQUIRED_FIELDS, validate_row


def main():
    full_path = data_dir("final") / "evaluation_parameters_full.jsonl"
    rows = list(load_jsonl(full_path))
    n = len(rows)

    all_errors: list[dict] = []
    extra_cols_seen: set[str] = set()
    for r in rows:
        errs = validate_row(r, allow_unmasked_token_count=True)
        if errs:
            all_errors.append({"query_id": r.get("query_id", "?"), "errors": errs})
        # extra columns vs schema rev.3
        extra = set(r.keys()) - REQUIRED_FIELDS
        extra_cols_seen.update(extra)

    cols_present = set()
    if rows:
        cols_present = set(rows[0].keys())

    status = "pass" if not all_errors and cols_present == REQUIRED_FIELDS else "fail"

    report = {
        "check": "schema_rev3",
        "n_rows": n,
        "n_errors": len(all_errors),
        "columns_expected": sorted(REQUIRED_FIELDS),
        "columns_present": sorted(cols_present),
        "extra_columns": sorted(extra_cols_seen),
        "missing_columns": sorted(REQUIRED_FIELDS - cols_present),
        "errors_sample": all_errors[:50],
        "threshold": "100% pass + exact 14-col match",
        "status": status,
    }

    out_path = data_dir("reports", "quality") / "schema.json"
    out_path.write_text(json.dumps(report, indent=2, ensure_ascii=False))
    print(f"[t1_01_schema_rev3] {status} | rows={n} errors={len(all_errors)} → {out_path}")
    sys.exit(0 if status == "pass" else 1)


if __name__ == "__main__":
    main()
