#!/usr/bin/env python3
"""T1-07: Distribution audit.

- length_band × dimension matrix
- shots × dimension matrix
- license / gated counts
- token stats per tokenizer
- Chi² independence test (length_band, dimension) — informational
"""

from __future__ import annotations

import json
import sys
from collections import Counter, defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "src"))

from brick_evals.io_utils import data_dir, load_jsonl


def stats(arr: list[int]) -> dict:
    if not arr:
        return {}
    s = sorted(arr)
    return {
        "min": s[0],
        "p25": s[len(s) // 4],
        "p50": s[len(s) // 2],
        "p90": s[int(len(s) * 0.9)],
        "p99": s[int(len(s) * 0.99)],
        "max": s[-1],
        "mean": round(sum(s) / len(s), 1),
    }


def main():
    rows = list(load_jsonl(data_dir("final") / "evaluation_parameters_full.jsonl"))
    n = len(rows)

    by_dim = Counter(r["dimension"] for r in rows)
    by_source = Counter(r["source"] for r in rows)
    by_license = Counter(r["license"] for r in rows)
    by_gated = Counter("gated" if r["gated"] else "open" for r in rows)
    by_length_band = Counter(r["length_band"] for r in rows)
    by_shots = Counter(r["shots"] for r in rows)

    length_x_dim: dict = defaultdict(lambda: defaultdict(int))
    shots_x_dim: dict = defaultdict(lambda: defaultdict(int))
    for r in rows:
        length_x_dim[r["length_band"]][r["dimension"]] += 1
        shots_x_dim[r["shots"]][r["dimension"]] += 1

    # token stats
    tok_qwen = stats([r["input_tokens_qwen"] for r in rows])
    tok_ds = stats([r["input_tokens_deepseek"] for r in rows])
    tok_kimi = stats([r["input_tokens_kimi"] for r in rows])

    # Chi² test
    chi2_pvalue = None
    chi2_stat = None
    try:
        import numpy as np
        from scipy.stats import chi2_contingency

        bands = sorted(by_length_band.keys())
        dims = sorted(by_dim.keys())
        contingency = np.array([[length_x_dim[b].get(d, 0) for d in dims] for b in bands])
        chi2_stat, chi2_pvalue, *_ = chi2_contingency(contingency)
        chi2_stat = round(float(chi2_stat), 4)
        chi2_pvalue = round(float(chi2_pvalue), 6)
    except Exception as e:
        chi2_pvalue = f"error: {type(e).__name__}: {str(e)[:120]}"

    # Sanity assertions
    asserts = []
    if by_dim["coding"] != 1000:
        asserts.append(f"coding count {by_dim['coding']} != 1000")
    if by_dim["math_reasoning"] != 1000:
        asserts.append(f"math_reasoning {by_dim['math_reasoning']} != 1000")
    if by_dim["planning_agentic"] != 1000:
        asserts.append(f"planning_agentic {by_dim['planning_agentic']} != 1000")
    if 6 != len(by_dim):
        asserts.append(f"dimensions count {len(by_dim)} != 6")

    # SimpleQA + agentic must be shots=0 (by design)
    for r in rows:
        if r["source"] == "SimpleQA" and r["shots"] != 0:
            asserts.append(f"SimpleQA row {r['query_id']} has shots={r['shots']}")
            break
        if r["dimension"] == "planning_agentic" and r["shots"] != 0:
            asserts.append(f"agentic row {r['query_id']} has shots={r['shots']}")
            break

    status = "pass" if not asserts else "fail"

    report = {
        "check": "distribution",
        "n_rows": n,
        "by_dimension": dict(by_dim),
        "by_source": dict(by_source),
        "by_license": dict(by_license),
        "by_gated": dict(by_gated),
        "by_length_band": dict(by_length_band),
        "by_shots": dict(by_shots),
        "length_band_x_dimension": {b: dict(d) for b, d in length_x_dim.items()},
        "shots_x_dimension": {s: dict(d) for s, d in shots_x_dim.items()},
        "token_stats": {
            "qwen": tok_qwen,
            "deepseek": tok_ds,
            "kimi": tok_kimi,
        },
        "chi2_length_x_dim": {"stat": chi2_stat, "p_value": chi2_pvalue},
        "sanity_failures": asserts,
        "threshold_production": "all sanity_failures empty + 6 dims, 1000-each for major",
        "status": status,
    }

    out_path = data_dir("reports", "quality") / "distribution.json"
    out_path.write_text(json.dumps(report, indent=2, ensure_ascii=False))
    print(f"[t1_07_distribution] {status} | sanity_fails={len(asserts)} → {out_path}")
    sys.exit(0 if status == "pass" else 1)


if __name__ == "__main__":
    main()
