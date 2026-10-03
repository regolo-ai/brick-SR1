#!/usr/bin/env python3
"""T3-02: Cohen's kappa da CSV completato 2 reviewer.

Carica sample_review.csv, calcola kappa, error_rate.
Gate: kappa >= 0.7 + error_rate < 3% (production-ready).
"""

from __future__ import annotations

import csv
import json
import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "src"))

from brick_evals.io_utils import data_dir

LABELS = ["ok", "low_quality", "ambiguous", "broken"]
GATE_KAPPA = 0.7
GATE_ERROR_RATE = 0.03


def cohen_kappa(labels1: list[str], labels2: list[str]) -> tuple[float, dict]:
    """Pure-python Cohen's kappa."""
    n = len(labels1)
    if n == 0 or n != len(labels2):
        return 0.0, {}
    obs_agree = sum(1 for a, b in zip(labels1, labels2, strict=False) if a == b) / n
    cnt1 = Counter(labels1)
    cnt2 = Counter(labels2)
    exp_agree = sum((cnt1[lab] / n) * (cnt2[lab] / n) for lab in set(cnt1) | set(cnt2))
    if exp_agree >= 1:
        return 1.0, {"obs_agree": obs_agree, "exp_agree": exp_agree}
    kappa = (obs_agree - exp_agree) / (1 - exp_agree)
    return kappa, {"obs_agree": obs_agree, "exp_agree": exp_agree}


def main():
    csv_path = data_dir("reports", "quality") / "sample_review.csv"
    if not csv_path.exists():
        print(f"[t3_02_kappa_calc] missing {csv_path} — run t3_01 first then have 2 reviewers fill it")
        sys.exit(1)

    rows = list(csv.DictReader(open(csv_path)))
    n = len(rows)
    n_with_labels = 0
    labels1 = []
    labels2 = []
    error_count = 0
    for r in rows:
        l1 = (r.get("reviewer1_label") or "").strip().lower()
        l2 = (r.get("reviewer2_label") or "").strip().lower()
        if not l1 or not l2:
            continue
        if l1 not in LABELS or l2 not in LABELS:
            print(f"  [warn] {r['query_id']}: invalid labels '{l1}'/'{l2}'")
            continue
        labels1.append(l1)
        labels2.append(l2)
        n_with_labels += 1
        if l1 != "ok" or l2 != "ok":
            error_count += 1

    kappa, agree = cohen_kappa(labels1, labels2)
    error_rate = error_count / n_with_labels if n_with_labels else 0
    pass_kappa = kappa >= GATE_KAPPA
    pass_error = error_rate < GATE_ERROR_RATE
    status = "pass" if pass_kappa and pass_error else "fail"

    summary = {
        "check": "manual_review_kappa",
        "n_total_csv": n,
        "n_with_labels": n_with_labels,
        "kappa": round(kappa, 4),
        "obs_agreement": round(agree.get("obs_agree", 0), 4),
        "exp_agreement": round(agree.get("exp_agree", 0), 4),
        "label_distribution_r1": dict(Counter(labels1)),
        "label_distribution_r2": dict(Counter(labels2)),
        "error_count": error_count,
        "error_rate": round(error_rate, 4),
        "gate_kappa": f">= {GATE_KAPPA}",
        "gate_error_rate": f"< {GATE_ERROR_RATE:.0%}",
        "status_kappa": "pass" if pass_kappa else "fail",
        "status_error_rate": "pass" if pass_error else "fail",
        "status": status,
    }
    out_path = data_dir("reports", "quality") / "kappa.json"
    out_path.write_text(json.dumps(summary, indent=2, ensure_ascii=False))
    print(f"[t3_02_kappa_calc] {status} | kappa={kappa:.3f} error_rate={error_rate:.2%} → {out_path}")
    sys.exit(0 if status == "pass" else 1)


if __name__ == "__main__":
    main()
