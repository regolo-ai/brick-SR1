#!/usr/bin/env python3
"""T1-15: Query non-empty — verifica che la query effettiva (post strip few-shot) non sia vuota.

Gate production: 0 query con actual_query troppo corta (<20 char) per source non-masked.
"""

from __future__ import annotations

import json
import sys
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "src"))

from brick_evals.dedup import extract_actual_query
from brick_evals.io_utils import data_dir, load_jsonl

GATE_PRODUCTION = 0
MIN_LEN = 20


def main():
    rows = list(load_jsonl(data_dir("final") / "evaluation_parameters_full.jsonl"))
    n = len(rows)

    empty = []
    by_source = defaultdict(int)

    for r in rows:
        if r.get("query") == "<masked>":
            continue
        actual = extract_actual_query(r["query"]).strip()
        # Strip leading marker (Question:, Problem:, etc.) to get true content
        for marker in ("Question:", "Problem:", "Instruction:", "Prompt:", "Task:", "Input:"):
            if actual.startswith(marker):
                actual = actual[len(marker) :].strip()
        # Strip trailing template suffixes
        for suffix in ("Solution:", "Answer:", "Response:", "Reasoning:", "Story:"):
            if actual.endswith(suffix):
                actual = actual[: -len(suffix)].strip()
        if len(actual) < MIN_LEN:
            by_source[r["source"]] += 1
            empty.append(
                {
                    "query_id": r["query_id"],
                    "source": r["source"],
                    "query_len": len(actual),
                    "snippet": actual[:200],
                }
            )

    n_flagged = len(empty)
    status = "pass" if n_flagged <= GATE_PRODUCTION else "fail"

    report = {
        "check": "query_nonempty",
        "config": {"min_len": MIN_LEN, "gate": GATE_PRODUCTION},
        "n_rows": n,
        "n_flagged": n_flagged,
        "by_source": dict(by_source),
        "sample": empty[:30],
        "threshold_production": f"<={GATE_PRODUCTION} empty queries",
        "status": status,
    }

    out_path = data_dir("reports", "quality") / "query_nonempty.json"
    out_path.write_text(json.dumps(report, indent=2, ensure_ascii=False))
    print(f"[t1_15_query_nonempty] {status} | flagged={n_flagged} → {out_path}")
    sys.exit(0 if status == "pass" else 1)


if __name__ == "__main__":
    main()
