"""Compute Cohen's kappa for Claude's annotations vs judge mean per dimension.

Uses linear-weighted kappa for ordinal scoring (0.0, 0.3, 0.5, 0.7, 1.0).
Output report + decision flag (kappa >= 0.4 means push to HF Hub OK).
"""

from __future__ import annotations

import csv
import json
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ANNOTATED = ROOT / "data" / "human_eval" / "sample_200_filled.csv"
REF = ROOT / "data" / "human_eval" / "judge_ref.json"
OUT = ROOT / "data" / "human_eval" / "kappa_report.json"

DIMS = [
    "instruction_following",
    "coding",
    "math_reasoning",
    "world_knowledge",
    "planning_agentic",
    "creative_synthesis",
]

BINS = [0.0, 0.2, 0.4, 0.6, 0.8, 1.0]  # bin boundaries (use indices 0..4 as ordinal categories)


def bin_score(x: float) -> int:
    for i in range(len(BINS) - 1):
        if x < BINS[i + 1]:
            return i
    return len(BINS) - 2


def cohens_kappa_weighted(y1: list[int], y2: list[int], n_cat: int) -> float:
    """Linear-weighted Cohen's kappa for ordinal data."""
    n = len(y1)
    if n == 0:
        return 0.0
    # confusion matrix
    M = [[0] * n_cat for _ in range(n_cat)]
    for a, b in zip(y1, y2, strict=False):
        M[a][b] += 1
    # marginals
    row_marg = [sum(row) for row in M]
    col_marg = [sum(M[r][c] for r in range(n_cat)) for c in range(n_cat)]
    # weights (linear)
    W = [[abs(i - j) / (n_cat - 1) for j in range(n_cat)] for i in range(n_cat)]
    # observed disagreement
    Po = sum(W[i][j] * M[i][j] for i in range(n_cat) for j in range(n_cat)) / n
    # expected disagreement
    Pe = sum(W[i][j] * row_marg[i] * col_marg[j] for i in range(n_cat) for j in range(n_cat)) / (n * n)
    if Pe == 0:
        return 1.0 if Po == 0 else 0.0
    return 1.0 - (Po / Pe)


def main() -> None:
    ref = json.loads(REF.read_text())
    annotated = []
    with ANNOTATED.open() as f:
        for r in csv.DictReader(f):
            annotated.append(r)

    per_dim = {}
    for d in DIMS:
        y_claude = []
        y_judge = []
        for r in annotated:
            qid = r["query_id"]
            if qid not in ref:
                continue
            y_claude.append(bin_score(float(r[d])))
            y_judge.append(bin_score(float(ref[qid][d])))
        kappa = cohens_kappa_weighted(y_claude, y_judge, n_cat=len(BINS) - 1)
        # also raw distributions
        per_dim[d] = {
            "kappa_linear_weighted": round(kappa, 4),
            "n": len(y_claude),
            "claude_dist": dict(Counter(y_claude)),
            "judge_dist": dict(Counter(y_judge)),
        }

    overall_kappa = sum(per_dim[d]["kappa_linear_weighted"] for d in DIMS) / len(DIMS)
    decision = "PASS_PUSH_HUB" if overall_kappa >= 0.4 else "REVIEW_NEEDED"

    report = {
        "n_records": len(annotated),
        "overall_mean_kappa": round(overall_kappa, 4),
        "decision_threshold": 0.4,
        "decision": decision,
        "per_dimension": per_dim,
    }
    OUT.write_text(json.dumps(report, indent=2))
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
