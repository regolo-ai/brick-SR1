#!/usr/bin/env python3
"""T2-03: Capability tag verification — judge classifica dimension del prompt.

Sample 10% stratificato per dimension. Judge predice quale delle 6 dimension è il prompt.
Confronta con dimension assegnata.
Gate: >=92% agreement.
"""

from __future__ import annotations

import json
import random
import sys
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "src"))

from brick_evals.dedup import extract_actual_query
from brick_evals.io_utils import data_dir, load_jsonl, save_jsonl
from brick_evals.regolo_client import RegoloClient

DIMENSIONS = [
    "instruction_following",
    "coding",
    "math_reasoning",
    "world_knowledge",
    "creative_synthesis",
    "planning_agentic",
]
SAMPLE_RATIO = 0.10
SEED = 42
GATE_AGREEMENT = 0.92

PROMPT = """Classifica il seguente prompt in UNA delle 6 categorie di capability LLM:

- instruction_following (segue istruzioni con constraint)
- coding (programmazione)
- math_reasoning (risoluzione problemi matematici)
- world_knowledge (conoscenza fattuale del mondo)
- creative_synthesis (scrittura creativa, generazione)
- planning_agentic (pianificazione multi-step, tool calling, agenti)

Rispondi SOLO con il nome esatto della categoria (snake_case), nient'altro.

PROMPT (truncated 2500 char):
{query}

CATEGORIA:"""


def main():
    rows = list(load_jsonl(data_dir("final") / "evaluation_parameters_full.jsonl"))
    rng = random.Random(SEED)

    by_dim = defaultdict(list)
    for r in rows:
        if r.get("query") == "<masked>":
            continue
        by_dim[r["dimension"]].append(r)

    sampled = []
    for _dim, lst in by_dim.items():
        k = max(1, int(len(lst) * SAMPLE_RATIO))
        sampled.extend(rng.sample(lst, min(k, len(lst))))

    n = len(sampled)
    print(f"[t2_03_capability_tag] classifying {n} rows...")

    client = RegoloClient()
    out_rows = []
    n_match = 0
    n_total = 0
    confusion: dict = defaultdict(lambda: defaultdict(int))

    for i, r in enumerate(sampled):
        if i % 25 == 0:
            print(f"  [{i}/{n}]")
        actual_q = extract_actual_query(r["query"])
        prompt = PROMPT.format(query=actual_q[:2500])
        try:
            ans = (
                client.text(
                    prompt,
                    system="Output: solo il nome della categoria, niente altro.",
                    temperature=0.0,
                    max_tokens=20,
                )
                .strip()
                .lower()
            )
        except Exception:
            ans = "[error]"
        # Find matching dimension
        predicted = None
        for d in DIMENSIONS:
            if d in ans:
                predicted = d
                break
        match = predicted == r["dimension"]
        if predicted:
            n_total += 1
            confusion[r["dimension"]][predicted] += 1
            if match:
                n_match += 1
        out_rows.append(
            {
                "query_id": r["query_id"],
                "source": r["source"],
                "true_dimension": r["dimension"],
                "predicted": predicted,
                "raw": ans[:80],
                "match": match,
            }
        )

    out_path = data_dir("reports", "quality") / "capability_tag.jsonl"
    save_jsonl(out_path, out_rows)

    agreement = n_match / n_total if n_total else 0
    status = "pass" if agreement >= GATE_AGREEMENT else "fail"

    summary = {
        "check": "capability_tag",
        "n_sampled": n,
        "n_judged": n_total,
        "n_match": n_match,
        "agreement": round(agreement, 4),
        "confusion_matrix": {k: dict(v) for k, v in confusion.items()},
        "gate": f">= {GATE_AGREEMENT:.0%}",
        "status": status,
    }
    summary_path = data_dir("reports", "quality") / "capability_tag_summary.json"
    summary_path.write_text(json.dumps(summary, indent=2, ensure_ascii=False))
    print(f"[t2_03_capability_tag] {status} | agreement={agreement:.2%} → {summary_path}")
    sys.exit(0 if status == "pass" else 1)


if __name__ == "__main__":
    main()
