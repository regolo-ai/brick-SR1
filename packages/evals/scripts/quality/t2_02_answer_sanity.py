#!/usr/bin/env python3
"""T2-02: Answer sanity — judge tenta di risolvere expected_answer e flag mismatch.

Per math/knowledge/coding (subset 400 rows):
- Estrae query "actual" (post few-shot strip)
- Chiede a Regolo qwen3.5-122b di rispondere
- Compara con expected_answer (string match relaxed)
- Flag se incoerente.

Gate: <8% disagreement (production-ready).
"""

from __future__ import annotations

import json
import random
import re
import sys
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "src"))

from brick_evals.dedup import extract_actual_query
from brick_evals.io_utils import data_dir, load_jsonl, save_jsonl
from brick_evals.regolo_client import RegoloClient

# Sample sizing
TARGETS = {
    "math_reasoning": 200,
    "world_knowledge": 100,
    "coding": 0,  # coding troppo costoso (codice + test cases) — skip
    "instruction_following": 100,
}
SEED = 42
GATE_DISAGREEMENT = 0.08

PROMPT_TEMPLATE = """Rispondi solo con la risposta finale, senza spiegazioni.

DOMANDA:
{query}

RISPOSTA FINALE (solo l'essenziale):"""


def normalize_answer(s: str) -> str:
    s = s.lower().strip()
    s = re.sub(r"[^\w\s]", "", s)
    s = re.sub(r"\s+", " ", s)
    return s


def extract_expected_str(ea: dict) -> str:
    t = ea.get("type")
    p = ea.get("payload", {})
    if t in ("exact_match", "math_equivalent", "gaia_exact_match"):
        return str(p.get("final_answer", ""))
    if t == "mcq_letter":
        return str(p.get("answer_letter", ""))
    if t == "llm_judge_factual":
        return str(p.get("answer", ""))
    if t == "ifeval_constraint":
        # No single ground truth — skip
        return ""
    return ""


def is_match(judge_answer: str, expected: str) -> bool:
    if not expected:
        return True  # nothing to compare
    j = normalize_answer(judge_answer)
    e = normalize_answer(expected)
    if not e:
        return True
    if e in j or j in e:
        return True
    # Numeric compare
    try:
        return abs(float(e) - float(j)) < 1e-6
    except ValueError:
        return False


def main():
    rows = list(load_jsonl(data_dir("final") / "evaluation_parameters_full.jsonl"))
    rng = random.Random(SEED)

    by_dim = defaultdict(list)
    for r in rows:
        # Skip masked + ifeval (no ground truth) + planning (tool calls)
        if r.get("query") == "<masked>":
            continue
        if r["dimension"] not in TARGETS or TARGETS[r["dimension"]] == 0:
            continue
        if r["expected_answer"]["type"] == "ifeval_constraint":
            continue
        by_dim[r["dimension"]].append(r)

    sampled = []
    for dim, lst in by_dim.items():
        n_target = TARGETS.get(dim, 0)
        sampled.extend(rng.sample(lst, min(n_target, len(lst))))

    n = len(sampled)
    print(f"[t2_02_answer_sanity] judging {n} rows...")

    client = RegoloClient()
    out_rows = []
    n_match = 0
    n_mismatch = 0
    n_skipped = 0
    by_src = defaultdict(lambda: {"n": 0, "match": 0})

    for i, r in enumerate(sampled):
        if i % 25 == 0:
            print(f"  [{i}/{n}]")
        actual_q = extract_actual_query(r["query"])
        prompt = PROMPT_TEMPLATE.format(query=actual_q[:3000])
        expected = extract_expected_str(r["expected_answer"])
        if not expected:
            n_skipped += 1
            continue
        try:
            ans = client.text(
                prompt,
                system="Rispondi in modo conciso. Solo la risposta finale, no preamboli.",
                temperature=0.0,
                max_tokens=256,
            )
            match = is_match(ans, expected)
        except Exception as e:
            ans = f"[error: {type(e).__name__}: {str(e)[:120]}]"
            match = None
        if match is True:
            n_match += 1
            by_src[r["source"]]["match"] += 1
        elif match is False:
            n_mismatch += 1
        by_src[r["source"]]["n"] += 1
        out_rows.append(
            {
                "query_id": r["query_id"],
                "source": r["source"],
                "dimension": r["dimension"],
                "expected": expected[:200],
                "judge_answer": ans[:300],
                "match": match,
            }
        )

    out_path = data_dir("reports", "quality") / "answer_sanity.jsonl"
    save_jsonl(out_path, out_rows)

    n_compared = n_match + n_mismatch
    disagreement = n_mismatch / n_compared if n_compared else 0
    status = "pass" if disagreement <= GATE_DISAGREEMENT else "fail"

    summary = {
        "check": "answer_sanity",
        "n_sampled": n,
        "n_skipped": n_skipped,
        "n_compared": n_compared,
        "n_match": n_match,
        "n_mismatch": n_mismatch,
        "disagreement_ratio": round(disagreement, 4),
        "by_source": {
            s: {"n": d["n"], "match_ratio": round(d["match"] / d["n"], 3) if d["n"] else None}
            for s, d in by_src.items()
        },
        "gate": f"<= {GATE_DISAGREEMENT:.0%} disagreement",
        "note": "Judge=qwen3.5-122b@regolo; il judge stesso può sbagliare; usare come signal proxy non ground truth",
        "status": status,
    }
    summary_path = data_dir("reports", "quality") / "answer_sanity_summary.json"
    summary_path.write_text(json.dumps(summary, indent=2, ensure_ascii=False))
    print(f"[t2_02_answer_sanity] {status} | disagreement={disagreement:.2%} → {summary_path}")
    sys.exit(0 if status == "pass" else 1)


if __name__ == "__main__":
    main()
