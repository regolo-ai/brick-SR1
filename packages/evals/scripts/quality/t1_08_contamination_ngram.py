#!/usr/bin/env python3
"""T1-08: Contamination 13-gram overlap (LMSYS llm-decontaminator style).

Per-source overlap vs known public reference texts (already downloaded in data/raw):
- GSM8K test, MATH-500, IFEval, EQ-Bench manifest, MMLU-Pro humanities, BFCL public, LiveCodeBench v6

Gate: <5% per source flagged (overlap_ratio>=0.5 → likely contamination).
"""

from __future__ import annotations

import json
import sys
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "src"))

from brick_evals.contamination import build_ngram_index, overlap_ratio
from brick_evals.io_utils import data_dir, load_jsonl

N = 13
OVERLAP_THRESHOLD = 0.5  # 50%+ ngrams in reference => likely contamination
GATE_PRODUCTION = 0.05  # <5% per source


def collect_reference_texts() -> dict[str, list[str]]:
    """Collect reference query texts from raw downloads, per source."""
    raw = data_dir("raw")
    out = {}
    candidates = {
        "GSM8K": ["gsm8k.jsonl", "openai_gsm8k.jsonl"],
        "MATH-500": ["math500.jsonl"],
        "IFEval": ["ifeval.jsonl", "google_ifeval.jsonl"],
        "MMLU-Pro-Humanities": ["mmlu_pro.jsonl"],
        "EQ-Bench-Creative-v3": ["eqbench_creative_v3.jsonl"],
        "BFCL-v4": ["bfcl_v4.jsonl"],
        "LiveCodeBench-v6": ["livecodebench_v6.jsonl"],
        "AIME-2025": ["aime_2025.jsonl"],
        "LitBench-Test": ["litbench_test.jsonl"],
        "IFBench": ["ifbench.jsonl"],
        "SimpleQA": ["simpleqa.jsonl"],
    }
    for src_label, fnames in candidates.items():
        for fn in fnames:
            p = raw / fn
            if p.exists():
                texts = []
                for r in load_jsonl(p):
                    # try most common text fields
                    txt = (
                        r.get("question") or r.get("query") or r.get("prompt") or r.get("text") or r.get("instruction")
                    )
                    if isinstance(txt, str) and txt.strip():
                        texts.append(txt)
                if texts:
                    out[src_label] = texts
                break
    return out


def main():
    rows = list(load_jsonl(data_dir("final") / "evaluation_parameters_full.jsonl"))
    n = len(rows)

    refs = collect_reference_texts()
    print(f"[t1_08_contamination_ngram] reference sources loaded: {list(refs.keys())}")

    # Build per-source ngram index from reference (own dataset = self-overlap is by-design, NOT contamination)
    ref_indices = {src: build_ngram_index(refs[src], n=N) for src in refs}

    # For each row, check overlap vs OTHER sources' reference
    flags = defaultdict(list)
    by_source_total = defaultdict(int)
    by_source_flagged = defaultdict(int)

    for r in rows:
        src = r["source"]
        by_source_total[src] += 1
        q_text = r["query"]
        # Strip few-shot block to focus on actual query (heuristic)
        q_query = q_text.split("\n\n")[-1] if "\n\n" in q_text else q_text
        if len(q_query.split()) < N:
            q_query = q_text
        for other_src, idx in ref_indices.items():
            if other_src == src:
                continue
            ratio = overlap_ratio(q_query, idx, n=N)
            if ratio >= OVERLAP_THRESHOLD:
                by_source_flagged[src] += 1
                flags[src].append(
                    {
                        "query_id": r["query_id"],
                        "from_source": src,
                        "matched_in": other_src,
                        "overlap_ratio": round(ratio, 3),
                    }
                )
                break

    per_source = {}
    fails = []
    for src, total in by_source_total.items():
        flagged = by_source_flagged[src]
        ratio = flagged / total
        per_source[src] = {
            "n": total,
            "flagged": flagged,
            "ratio": round(ratio, 4),
            "status": "pass" if ratio < GATE_PRODUCTION else "fail",
        }
        if ratio >= GATE_PRODUCTION:
            fails.append(src)

    status = "pass" if not fails else "fail"

    report = {
        "check": "contamination_ngram",
        "config": {"n_gram": N, "overlap_threshold": OVERLAP_THRESHOLD, "gate": GATE_PRODUCTION},
        "n_rows": n,
        "reference_sources": list(refs.keys()),
        "per_source": per_source,
        "failed_sources": fails,
        "flag_sample": {k: v[:5] for k, v in flags.items()},
        "threshold_production": f"<{GATE_PRODUCTION:.0%} per source",
        "note": (
            "Contamination = query appare in reference di ALTRA source. Self-overlap by-design "
            "(la query appare nel proprio reference) NON è contaminazione."
        ),
        "status": status,
    }

    out_path = data_dir("reports", "quality") / "contamination.json"
    out_path.write_text(json.dumps(report, indent=2, ensure_ascii=False))
    print(f"[t1_08_contamination_ngram] {status} | failed_sources={fails} → {out_path}")
    sys.exit(0 if status == "pass" else 1)


if __name__ == "__main__":
    main()
