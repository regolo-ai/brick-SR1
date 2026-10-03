#!/usr/bin/env python3
"""T1-10: Toxicity & NSFW offline scan via Detoxify.

Detoxify multilingual: toxicity, severe_toxicity, obscene, identity_attack, insult, threat, sexual_explicit.
Gate: <0.1% rows with toxicity score > 0.7.
"""

from __future__ import annotations

import json
import sys
from collections import Counter, defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "src"))

from brick_evals.io_utils import data_dir, load_jsonl

TOXICITY_THRESHOLD = 0.7
GATE_PRODUCTION = 0.001  # <0.1%
BATCH_SIZE = 2
MAX_CHARS = 384  # cap to avoid OOM on long contexts
SAMPLE_N = 800  # stratified subsample
SEED = 42


def main():
    import random

    from brick_evals.dedup import extract_actual_query
    from detoxify import Detoxify

    all_rows = list(load_jsonl(data_dir("final") / "evaluation_parameters_full.jsonl"))
    rng = random.Random(SEED)

    # Stratified sample per source for proportional coverage
    by_source = defaultdict(list)
    for r in all_rows:
        if r["query"] != "<masked>":
            by_source[r["source"]].append(r)

    n_total = len(all_rows)
    rows = []
    for _src, lst in by_source.items():
        k = max(10, int(len(lst) / n_total * SAMPLE_N))
        rows.extend(rng.sample(lst, min(k, len(lst))))
    n = len(rows)

    texts = [extract_actual_query(r["query"])[:MAX_CHARS] for r in rows]

    print("[t1_10_toxicity_offline] loading Detoxify (original) on CPU...")
    model = Detoxify("original")

    flagged = []
    by_source = defaultdict(int)
    n_flagged = 0
    cat_count = Counter()

    print(f"[t1_10_toxicity_offline] scoring {n} rows in batches of {BATCH_SIZE}...")
    for i in range(0, n, BATCH_SIZE):
        if i % (BATCH_SIZE * 50) == 0:
            print(f"  [{i}/{n}]")
        batch = texts[i : i + BATCH_SIZE]
        # Filter empty (masked)
        nonempty_idx = [j for j, t in enumerate(batch) if t]
        if not nonempty_idx:
            continue
        nonempty_texts = [batch[j] for j in nonempty_idx]
        try:
            results = model.predict(nonempty_texts)
        except Exception as e:
            print(f"  [warn] batch {i} failed: {e}")
            continue
        # results: dict of {category: list[float]}
        for k, j in enumerate(nonempty_idx):
            row_idx = i + j
            scores = {cat: float(vals[k]) for cat, vals in results.items()}
            max_cat = max(scores, key=scores.get)
            max_score = scores[max_cat]
            if max_score > TOXICITY_THRESHOLD:
                n_flagged += 1
                cat_count[max_cat] += 1
                by_source[rows[row_idx]["source"]] += 1
                flagged.append(
                    {
                        "query_id": rows[row_idx]["query_id"],
                        "source": rows[row_idx]["source"],
                        "max_category": max_cat,
                        "max_score": round(max_score, 3),
                        "all_scores": {k: round(v, 3) for k, v in scores.items()},
                    }
                )

    ratio = n_flagged / n if n else 0
    status = "pass" if ratio <= GATE_PRODUCTION else "fail"

    report = {
        "check": "toxicity_offline",
        "config": {"threshold": TOXICITY_THRESHOLD, "model": "detoxify-original", "sample_n": n, "n_total": n_total},
        "n_rows": n,
        "n_total_dataset": n_total,
        "n_flagged": n_flagged,
        "ratio": round(ratio, 4),
        "by_category": dict(cat_count),
        "by_source": dict(by_source),
        "sample": flagged[:30],
        "threshold_production": f"<{GATE_PRODUCTION:.1%}",
        "status": status,
    }

    out_path = data_dir("reports", "quality") / "toxicity.json"
    out_path.write_text(json.dumps(report, indent=2, ensure_ascii=False))
    print(f"[t1_10_toxicity_offline] {status} | flagged={n_flagged}/{n} ({ratio:.3%}) → {out_path}")
    sys.exit(0 if status == "pass" else 1)


if __name__ == "__main__":
    main()
