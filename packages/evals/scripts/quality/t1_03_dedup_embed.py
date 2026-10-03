#!/usr/bin/env python3
"""T1-03: Semantic dedup via sentence-transformers all-mpnet-base-v2 + FAISS cosine.

CPU encoding ~2-4 min on 5339 rows.
Output: data/reports/quality/dedup_embed.json {n_pairs, ratio, sample, status}.
Threshold: <1% rows in pair.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "src"))

from brick_evals.dedup import encode_embeddings, extract_actual_query, find_semantic_duplicates
from brick_evals.io_utils import data_dir, load_jsonl

MODEL = "sentence-transformers/all-mpnet-base-v2"
THRESHOLD = 0.92
TOPK = 10
GATE_CROSS_SOURCE = 0.01
GATE_INTRA_SOURCE = 0.20


def main():
    rows = list(load_jsonl(data_dir("final") / "evaluation_parameters_full.jsonl"))
    n = len(rows)
    texts = [extract_actual_query(r["query"])[:1024] for r in rows]  # strip few-shot, cap RAM
    qids = [r["query_id"] for r in rows]
    sources = [r["source"] for r in rows]
    dims = [r["dimension"] for r in rows]

    print(f"[t1_03_dedup_embed] encoding {n} texts via {MODEL} on CPU...")
    emb = encode_embeddings(texts, model_name=MODEL, batch_size=32)
    print(f"[t1_03_dedup_embed] embeddings shape={emb.shape}, finding pairs cosine>={THRESHOLD}...")

    pairs = find_semantic_duplicates(emb, threshold=THRESHOLD, k=TOPK)

    cross_source = []
    intra_source = []
    rows_cross = set()
    rows_intra = set()
    from collections import Counter

    intra_by_source = Counter()
    for i, j, score in pairs:
        entry = {
            "a": qids[i],
            "b": qids[j],
            "cosine": round(score, 4),
            "source_a": sources[i],
            "source_b": sources[j],
            "dim_a": dims[i],
            "dim_b": dims[j],
        }
        if sources[i] != sources[j]:
            cross_source.append(entry)
            rows_cross.add(i)
            rows_cross.add(j)
        else:
            intra_source.append(entry)
            intra_by_source[sources[i]] += 1
            rows_intra.add(i)
            rows_intra.add(j)

    ratio_cross = len(rows_cross) / n if n else 0
    ratio_intra = len(rows_intra) / n if n else 0
    cross_pass = ratio_cross < GATE_CROSS_SOURCE
    intra_pass = ratio_intra < GATE_INTRA_SOURCE
    status = "pass" if cross_pass and intra_pass else "fail"

    report = {
        "check": "dedup_embed",
        "config": {"model": MODEL, "threshold": THRESHOLD, "topk": TOPK},
        "n_rows": n,
        "n_pairs": len(pairs),
        "cross_source": {
            "n_pairs": len(cross_source),
            "n_rows_involved": len(rows_cross),
            "ratio": round(ratio_cross, 4),
            "gate": f"<{GATE_CROSS_SOURCE:.0%}",
            "status": "pass" if cross_pass else "fail",
        },
        "intra_source": {
            "n_pairs": len(intra_source),
            "n_rows_involved": len(rows_intra),
            "ratio": round(ratio_intra, 4),
            "gate": f"<{GATE_INTRA_SOURCE:.0%}",
            "status": "pass" if intra_pass else "fail",
            "by_source": dict(intra_by_source),
        },
        "cross_source_sample": cross_source[:30],
        "intra_source_sample": intra_source[:10],
        "status": status,
    }

    out_path = data_dir("reports", "quality") / "dedup_embed.json"
    out_path.write_text(json.dumps(report, indent=2, ensure_ascii=False))
    print(
        f"[t1_03_dedup_embed] {status} | cross={len(cross_source)} ({ratio_cross:.2%}) "
        f"intra={len(intra_source)} ({ratio_intra:.2%}) → {out_path}"
    )
    sys.exit(0 if status == "pass" else 1)


if __name__ == "__main__":
    main()
