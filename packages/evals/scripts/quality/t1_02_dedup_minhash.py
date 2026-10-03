#!/usr/bin/env python3
"""T1-02: MinHash+LSH near-dedup cross-source.

threshold=0.75, num_perm=128, n_gram=5 (word level).
Output: data/reports/quality/dedup_minhash.json {n_pairs, cross_source_pairs, sample, ratio, status}.
Threshold gating: <2% rows in pairs.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "src"))

from brick_evals.dedup import build_lsh_index
from brick_evals.io_utils import data_dir, load_jsonl

THRESHOLD = 0.75
NUM_PERM = 128
N_GRAM = 5
# Gate: cross-source <2% (vera leak); intra-source informational (replicas by design legit per EQ-Bench iter=3 etc.)
GATE_CROSS_SOURCE = 0.02
GATE_INTRA_SOURCE = 0.20  # accomodare replicas by-design


def main():
    rows = list(load_jsonl(data_dir("final") / "evaluation_parameters_full.jsonl"))
    n = len(rows)
    print(f"[t1_02_dedup_minhash] building LSH on {n} rows (threshold={THRESHOLD}, num_perm={NUM_PERM})...")

    lsh, sigs = build_lsh_index(rows, threshold=THRESHOLD, num_perm=NUM_PERM, n_gram=N_GRAM)
    qid_to_source = {r["query_id"]: r["source"] for r in rows}
    qid_to_dim = {r["query_id"]: r["dimension"] for r in rows}

    seen_pairs: set[tuple[str, str]] = set()
    cross_source_pairs = []
    intra_source_pairs = []
    rows_in_dup_cross: set[str] = set()
    rows_in_dup_intra: set[str] = set()

    for qid, m in sigs.items():
        matches = lsh.query(m)
        for other in matches:
            if other == qid:
                continue
            pair = tuple(sorted([qid, other]))
            if pair in seen_pairs:
                continue
            seen_pairs.add(pair)
            entry = {
                "a": pair[0],
                "b": pair[1],
                "source_a": qid_to_source[pair[0]],
                "source_b": qid_to_source[pair[1]],
                "dim_a": qid_to_dim[pair[0]],
                "dim_b": qid_to_dim[pair[1]],
            }
            if entry["source_a"] != entry["source_b"]:
                cross_source_pairs.append(entry)
                rows_in_dup_cross.add(qid)
                rows_in_dup_cross.add(other)
            else:
                intra_source_pairs.append(entry)
                rows_in_dup_intra.add(qid)
                rows_in_dup_intra.add(other)

    ratio_cross = len(rows_in_dup_cross) / n if n else 0
    ratio_intra = len(rows_in_dup_intra) / n if n else 0
    cross_pass = ratio_cross < GATE_CROSS_SOURCE
    intra_pass = ratio_intra < GATE_INTRA_SOURCE
    status = "pass" if cross_pass and intra_pass else "fail"

    # Per-source intra count (informational)
    from collections import Counter

    intra_by_source = Counter()
    for p in intra_source_pairs:
        intra_by_source[p["source_a"]] += 1

    report = {
        "check": "dedup_minhash",
        "config": {"threshold": THRESHOLD, "num_perm": NUM_PERM, "n_gram": N_GRAM},
        "n_rows": n,
        "n_pairs_total": len(seen_pairs),
        "cross_source": {
            "n_pairs": len(cross_source_pairs),
            "n_rows_involved": len(rows_in_dup_cross),
            "ratio": round(ratio_cross, 4),
            "gate": f"<{GATE_CROSS_SOURCE:.0%}",
            "status": "pass" if cross_pass else "fail",
        },
        "intra_source": {
            "n_pairs": len(intra_source_pairs),
            "n_rows_involved": len(rows_in_dup_intra),
            "ratio": round(ratio_intra, 4),
            "gate": f"<{GATE_INTRA_SOURCE:.0%}",
            "status": "pass" if intra_pass else "fail",
            "by_source": dict(intra_by_source),
            "note": "intra-source pairs ammessi se by-design (es. EQ-Bench-Creative-v3 iter=3, MMLU-Pro varianti option order)",
        },
        "cross_source_sample": cross_source_pairs[:30],
        "intra_source_sample": intra_source_pairs[:10],
        "status": status,
    }

    out_path = data_dir("reports", "quality") / "dedup_minhash.json"
    out_path.write_text(json.dumps(report, indent=2, ensure_ascii=False))
    print(
        f"[t1_02_dedup_minhash] {status} | cross={len(cross_source_pairs)} ({ratio_cross:.2%}) "
        f"intra={len(intra_source_pairs)} ({ratio_intra:.2%}) → {out_path}"
    )
    sys.exit(0 if status == "pass" else 1)


if __name__ == "__main__":
    main()
