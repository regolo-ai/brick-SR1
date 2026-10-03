#!/usr/bin/env python3
"""T3-03: Merge R2 labels da CSV scaricato + ricalcola kappa.

Input: /tmp/r2_labels.csv (download da sample_review_r2.html)
Output: aggiorna data/reports/quality/sample_review.csv con reviewer2_label/notes;
        rilancia t3_02_kappa_calc.py.
"""

from __future__ import annotations

import csv
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "src"))

from brick_evals.io_utils import data_dir

R2_PATH = Path("/tmp/r2_labels.csv")


def main():
    if not R2_PATH.exists():
        # Try other common locations
        for alt in [Path.home() / "Downloads" / "r2_labels.csv", Path("/root/Downloads/r2_labels.csv")]:
            if alt.exists():
                R2_PATH.write_text(alt.read_text())
                print(f"copied {alt} → {R2_PATH}")
                break
        else:
            print(f"missing {R2_PATH}. Download r2_labels.csv from HTML and save to /tmp/r2_labels.csv")
            sys.exit(1)

    r2_rows = list(csv.DictReader(open(R2_PATH)))
    r2_map = {r["query_id"]: (r.get("reviewer2_label", ""), r.get("reviewer2_notes", "")) for r in r2_rows}
    print(f"loaded {len(r2_map)} R2 labels from {R2_PATH}")

    csv_path = data_dir("reports", "quality") / "sample_review.csv"
    rows = list(csv.DictReader(open(csv_path)))
    n_updated = 0
    for r in rows:
        if r["query_id"] in r2_map:
            r["reviewer2_label"], r["reviewer2_notes"] = r2_map[r["query_id"]]
            n_updated += 1
    with open(csv_path, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=rows[0].keys())
        w.writeheader()
        w.writerows(rows)
    print(f"updated {n_updated} rows in {csv_path}")

    # Run kappa
    rc = subprocess.run(
        ["python3", str(Path(__file__).resolve().parent / "t3_02_kappa_calc.py")],
        env={"PYTHONPATH": str(Path(__file__).resolve().parents[2] / "src")},
    ).returncode
    sys.exit(rc)


if __name__ == "__main__":
    main()
