#!/usr/bin/env python3
"""T1-11: IRT-ready proxy difficulty manifest.

NB: vera analisi IRT richiede risposte modelli. Qui generiamo MANIFEST proxy
basato su (length_band, source, dimension) — utile per stratificazione futura.
"""

from __future__ import annotations

import json
import sys
from collections import Counter, defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "src"))

from brick_evals.io_utils import data_dir, load_jsonl

# Source-level a priori difficulty (informational, da paper benchmark / community)
SOURCE_PRIOR_DIFFICULTY = {
    "AIME-2025": "high",
    "MATH-500": "med",
    "GSM8K": "low",
    "GPQA-Diamond": "high",
    "MMLU-Pro-Humanities": "med",
    "SimpleQA": "high",  # short ma no retrieval = hard
    "LiveCodeBench-v6": "high",
    "IFEval": "low",
    "IFBench": "med",
    "BFCL-v4": "med",
    "tau-bench": "high",
    "Planning-Custom": "med",
    "EQ-Bench-Creative-v3": "med",
    "LitBench-Test": "med",
    "Custom-Validated": "med",
    "GAIA-L1L2": "high",
}


def proxy_difficulty(row: dict) -> str:
    """Proxy difficulty: combine source prior + length_band."""
    src_d = SOURCE_PRIOR_DIFFICULTY.get(row["source"], "unknown")
    band = row["length_band"]
    if src_d == "unknown":
        if band == "long":
            return "med"
        return band
    return src_d


def main():
    rows = list(load_jsonl(data_dir("final") / "evaluation_parameters_full.jsonl"))
    n = len(rows)

    proxy = []
    by_diff = Counter()
    by_diff_dim: dict = defaultdict(lambda: defaultdict(int))
    for r in rows:
        d = proxy_difficulty(r)
        proxy.append(
            {"query_id": r["query_id"], "dimension": r["dimension"], "source": r["source"], "proxy_difficulty": d}
        )
        by_diff[d] += 1
        by_diff_dim[d][r["dimension"]] += 1

    # Save manifest jsonl
    manifest_path = data_dir("reports", "quality") / "irt_proxy_manifest.jsonl"
    with open(manifest_path, "w") as f:
        for entry in proxy:
            f.write(json.dumps(entry) + "\n")

    report = {
        "check": "irt_proxy",
        "n_rows": n,
        "by_proxy_difficulty": dict(by_diff),
        "by_difficulty_x_dimension": {d: dict(dd) for d, dd in by_diff_dim.items()},
        "manifest_file": str(manifest_path),
        "note": "Proxy preliminare. Vera IRT richiede correctness scores 3 modelli (Phase 2).",
        "status": "pass",
    }

    out_path = data_dir("reports", "quality") / "irt_proxy.json"
    out_path.write_text(json.dumps(report, indent=2, ensure_ascii=False))
    print(f"[t1_11_irt_proxy] pass | manifest={n} entries → {out_path}")


if __name__ == "__main__":
    main()
