#!/usr/bin/env python3
"""T3-01: Stratified manual review CSV (1% per dimension×source×length_band).

Output: data/reports/quality/sample_review.csv con campi:
- query_id, dimension, source, length_band, query_truncated, expected_answer_type, expected_answer_summary
- reviewer1_label (vuoto, da compilare): "ok" | "low_quality" | "ambiguous" | "broken"
- reviewer1_notes (vuoto)
- reviewer2_label, reviewer2_notes (vuoto)

Esegui PRIMA di t3_02 (kappa). Reviewer 1+2 compilano CSV offline; t3_02 calcola Cohen's kappa.
"""

from __future__ import annotations

import csv
import json
import random
import sys
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "src"))

from brick_evals.dedup import extract_actual_query
from brick_evals.io_utils import data_dir, load_jsonl

SAMPLE_RATIO = 0.01  # 1% → ~54 rows
MIN_PER_CELL = 1
SEED = 42


def main():
    rows = list(load_jsonl(data_dir("final") / "evaluation_parameters_full.jsonl"))
    rng = random.Random(SEED)

    # Stratify: dimension × source × length_band
    by_cell = defaultdict(list)
    for r in rows:
        if r.get("query") == "<masked>":
            continue
        cell = (r["dimension"], r["source"], r["length_band"])
        by_cell[cell].append(r)

    sampled = []
    for _cell, lst in by_cell.items():
        n_target = max(MIN_PER_CELL, int(len(lst) * SAMPLE_RATIO))
        sampled.extend(rng.sample(lst, min(n_target, len(lst))))

    # Sort by query_id for stable CSV
    sampled.sort(key=lambda r: r["query_id"])
    n = len(sampled)

    out_path = data_dir("reports", "quality") / "sample_review.csv"
    with open(out_path, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(
            [
                "query_id",
                "dimension",
                "source",
                "length_band",
                "shots",
                "expected_type",
                "expected_summary",
                "actual_query_truncated",
                "reviewer1_label",
                "reviewer1_notes",
                "reviewer2_label",
                "reviewer2_notes",
            ]
        )
        for r in sampled:
            actual_q = extract_actual_query(r["query"])
            ea = r["expected_answer"]
            ea_sum = json.dumps(ea.get("payload"), ensure_ascii=False)[:300]
            w.writerow(
                [
                    r["query_id"],
                    r["dimension"],
                    r["source"],
                    r["length_band"],
                    r["shots"],
                    ea.get("type"),
                    ea_sum,
                    actual_q[:600],
                    "",
                    "",
                    "",
                    "",
                ]
            )

    # Manifest with cells covered
    cells_used = sorted({(r["dimension"], r["source"], r["length_band"]) for r in sampled})
    summary = {
        "check": "sample_review_csv",
        "n_total": len(rows),
        "n_sampled": n,
        "ratio": round(n / len(rows), 4),
        "n_cells": len(cells_used),
        "csv_path": str(out_path.relative_to(Path.cwd())) if out_path.is_relative_to(Path.cwd()) else str(out_path),
        "labels": ["ok", "low_quality", "ambiguous", "broken"],
        "instructions": "Reviewer1 + Reviewer2 compilano label_x e notes_x. Salvare CSV. Eseguire t3_02_kappa_calc.py.",
        "status": "pass",
    }
    out_summary = data_dir("reports", "quality") / "sample_review_manifest.json"
    out_summary.write_text(json.dumps(summary, indent=2, ensure_ascii=False))
    print(f"[t3_01_sample_review] sampled {n} rows ({n / len(rows):.2%}) → {out_path}")


if __name__ == "__main__":
    main()
