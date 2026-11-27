#!/usr/bin/env python3
"""T2-01: Few-shot coherence — judge rubric per source con synthetic fewshot.

Target: 6 source generate da Regolo (rev.3 fewshot synthetic).
Rubric 5-axes (1-5 score): format, cot_validity, answer_alignment, hallucination_inverse,
sufficiency. Verdict: pass/fail. 3 judges (temp 0.2/0.5/0.8) majority vote.
Sample: 100 rows per source (max 600). Total ~1800 calls.
Cost: ~$8.

Output: data/reports/quality/fewshot_coherence.jsonl (per-row) + summary in fewshot_coherence_summary.json.
Gate: avg_score >= 4.0/5 per source.
"""

from __future__ import annotations

import json
import random
import sys
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "src"))

from brick_evals.io_utils import data_dir, load_jsonl, save_jsonl
from brick_evals.judge import Judge

# Synthetic fewshot sources (rev.3): MATH-500, AIME-2025, LiveCodeBench-v6, IFEval, GPQA-Diamond, EQ-Bench-Creative-v3
TARGET_SOURCES = {
    "MATH-500",
    "AIME-2025",
    "LiveCodeBench-v6",
    "IFEval",
    "GPQA-Diamond",
    "EQ-Bench-Creative-v3",
}
SAMPLE_PER_SOURCE = 100  # 100 × 6 = 600 rows × 3 judges = 1800 calls
GATE_AVG_SCORE = 4.0
SEED = 42

AXES = ["format", "cot_validity", "answer_alignment", "hallucination_inverse", "sufficiency"]

RUBRIC_PROMPT = """Devi valutare la qualità di esempi few-shot CoT (Chain-of-Thought) per benchmark LLM.

Sei un valutatore meticoloso. Per il prompt few-shot dato, valuta su 5 assi (score 1-5, dove 5=eccellente):

1. **format**: gli esempi rispettano un formato consistente e atteso per il benchmark?
2. **cot_validity**: il reasoning step-by-step è logico e privo di errori?
3. **answer_alignment**: la risposta finale è coerente con il reasoning?
4. **hallucination_inverse**: GLI ESEMPI sono privi di hallucination o info inventate (5=privi, 1=pieno di hallucination)?
5. **sufficiency**: gli esempi sono SUFFICIENTI a guidare il modello sul task?

Verdict finale: "pass" se tutti gli score >=3, altrimenti "fail".

OUTPUT JSON solo (no markdown):
{{
  "format": <int 1-5>,
  "cot_validity": <int 1-5>,
  "answer_alignment": <int 1-5>,
  "hallucination_inverse": <int 1-5>,
  "sufficiency": <int 1-5>,
  "verdict": "pass" | "fail",
  "rationale": "<max 200 char>"
}}

=== SOURCE: {source} ===
=== DIMENSION: {dimension} ===

=== PROMPT FEW-SHOT (truncated 4000 char): ===
{prompt}

=== JSON: ==="""


def main():
    rows = list(load_jsonl(data_dir("final") / "evaluation_parameters_full.jsonl"))
    by_src = defaultdict(list)
    for r in rows:
        if r["source"] in TARGET_SOURCES and r["shots"] == 5:
            by_src[r["source"]].append(r)

    rng = random.Random(SEED)
    sampled = []
    for _src, lst in by_src.items():
        if len(lst) > SAMPLE_PER_SOURCE:
            sampled.extend(rng.sample(lst, SAMPLE_PER_SOURCE))
        else:
            sampled.extend(lst)

    n_sampled = len(sampled)
    print(f"[t2_01_fewshot_coherence] judging {n_sampled} rows × 3 judges = {n_sampled * 3} calls...")

    judge = Judge(n_judges=3)
    out_rows = []
    src_scores = defaultdict(list)

    for i, r in enumerate(sampled):
        if i % 10 == 0:
            print(f"  [{i}/{n_sampled}] {r['source']} {r['query_id']}")
        prompt = RUBRIC_PROMPT.format(
            source=r["source"],
            dimension=r["dimension"],
            prompt=r["query"][:4000],
        )
        try:
            result = judge.score(prompt, axes=AXES, max_tokens=512)
        except Exception as e:
            result = {"scores": {}, "verdict": "error", "n_parsed": 0, "error": str(e)[:200]}
        out_row = {
            "query_id": r["query_id"],
            "source": r["source"],
            "dimension": r["dimension"],
            "scores": result.get("scores", {}),
            "verdict": result.get("verdict"),
            "n_parsed": result.get("n_parsed", 0),
        }
        out_rows.append(out_row)
        # Aggregate per-source mean across all axes
        if result.get("scores"):
            avg = sum(result["scores"].values()) / len(result["scores"])
            src_scores[r["source"]].append(avg)

    # Save per-row
    out_path = data_dir("reports", "quality") / "fewshot_coherence.jsonl"
    save_jsonl(out_path, out_rows)

    # Summary
    summary = {}
    fails = []
    for src, vals in src_scores.items():
        avg = round(sum(vals) / len(vals), 3) if vals else 0.0
        summary[src] = {
            "n_judged": len(vals),
            "avg_score": avg,
            "status": "pass" if avg >= GATE_AVG_SCORE else "fail",
        }
        if avg < GATE_AVG_SCORE:
            fails.append(src)

    status = "pass" if not fails else "fail"
    summary_report = {
        "check": "fewshot_coherence",
        "n_sampled": n_sampled,
        "n_calls": n_sampled * 3,
        "axes": AXES,
        "per_source": summary,
        "failed_sources": fails,
        "gate": f">= {GATE_AVG_SCORE}/5",
        "status": status,
    }

    summary_path = data_dir("reports", "quality") / "fewshot_coherence_summary.json"
    summary_path.write_text(json.dumps(summary_report, indent=2, ensure_ascii=False))
    print(f"[t2_01_fewshot_coherence] {status} | failed_sources={fails} → {summary_path}")
    sys.exit(0 if status == "pass" else 1)


if __name__ == "__main__":
    main()
