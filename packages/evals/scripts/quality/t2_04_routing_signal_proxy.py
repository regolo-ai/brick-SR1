#!/usr/bin/env python3
"""T2-04: Routing signal proxy — judge predice success di 3 modelli.

Per ogni row sampled, judge classifica likely outcome:
- "all_succeed" (3/3) → no routing signal
- "all_fail" (0/3) → no routing signal
- "mixed" (1-2/3) → routing signal presente

Gate: <25% delle row con previsione unanime (all_succeed + all_fail < 25%).
"""

from __future__ import annotations

import json
import random
import sys
from collections import Counter, defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "src"))

from brick_evals.dedup import extract_actual_query
from brick_evals.io_utils import data_dir, load_jsonl, save_jsonl
from brick_evals.regolo_client import RegoloClient

SAMPLE_RATIO = 0.10
SEED = 42
GATE_UNANIMOUS = 0.25

PROMPT = """Considera 3 LLM con capability diverse:
- A: qwen3.5-9b (small, ~9B params, weakest)
- B: deepseek-v4-flash (medium, MoE, strong reasoning)
- C: kimi2.6 (large, 1T MoE, strongest, best on long-context)

Per il PROMPT seguente, predici se ciascun modello otterrebbe la risposta CORRETTA.

PROMPT (source: {source}, dimension: {dimension}, truncated):
{query}

Rispondi in JSON, niente altro:
{{
  "A_success": true | false,
  "B_success": true | false,
  "C_success": true | false,
  "rationale": "<max 150 char>"
}}

JSON:"""


def parse_predictions(text: str) -> dict | None:
    text = text.strip()
    if text.startswith("```"):
        lines = text.splitlines()
        if lines[0].startswith("```"):
            lines = lines[1:]
        if lines and lines[-1].startswith("```"):
            lines = lines[:-1]
        text = "\n".join(lines).strip()
    s = text.find("{")
    e = text.rfind("}")
    if s == -1 or e == -1:
        return None
    try:
        obj = json.loads(text[s : e + 1])
        if all(k in obj for k in ("A_success", "B_success", "C_success")):
            return obj
    except json.JSONDecodeError:
        return None
    return None


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
    print(f"[t2_04_routing_signal_proxy] judging {n} rows...")

    client = RegoloClient()
    out_rows = []
    pattern_count = Counter()
    by_dim_pattern: dict = defaultdict(Counter)

    for i, r in enumerate(sampled):
        if i % 25 == 0:
            print(f"  [{i}/{n}]")
        actual_q = extract_actual_query(r["query"])
        prompt = PROMPT.format(
            source=r["source"],
            dimension=r["dimension"],
            query=actual_q[:2500],
        )
        try:
            text = client.text(prompt, system="Output: solo JSON.", temperature=0.3, max_tokens=256)
            pred = parse_predictions(text)
        except Exception as e:
            pred = None
            text = f"[error: {type(e).__name__}]"
        if pred is None:
            pattern = "unparseable"
        else:
            successes = sum([bool(pred["A_success"]), bool(pred["B_success"]), bool(pred["C_success"])])
            if successes == 3:
                pattern = "all_succeed"
            elif successes == 0:
                pattern = "all_fail"
            else:
                pattern = f"mixed_{successes}"
        pattern_count[pattern] += 1
        by_dim_pattern[r["dimension"]][pattern] += 1
        out_rows.append(
            {
                "query_id": r["query_id"],
                "source": r["source"],
                "dimension": r["dimension"],
                "pred": pred,
                "pattern": pattern,
            }
        )

    out_path = data_dir("reports", "quality") / "routing_signal.jsonl"
    save_jsonl(out_path, out_rows)

    n_unanimous = pattern_count["all_succeed"] + pattern_count["all_fail"]
    ratio_unanimous = n_unanimous / n if n else 0
    status = "pass" if ratio_unanimous < GATE_UNANIMOUS else "fail"

    summary = {
        "check": "routing_signal_proxy",
        "n_sampled": n,
        "patterns": dict(pattern_count),
        "ratio_unanimous": round(ratio_unanimous, 4),
        "by_dimension": {d: dict(p) for d, p in by_dim_pattern.items()},
        "gate": f"unanimous < {GATE_UNANIMOUS:.0%}",
        "status": status,
        "note": "Judge predicts model success — proxy senza inference reali. Vera valutazione richiede Phase 2.",
    }
    summary_path = data_dir("reports", "quality") / "routing_signal_summary.json"
    summary_path.write_text(json.dumps(summary, indent=2, ensure_ascii=False))
    print(f"[t2_04_routing_signal_proxy] {status} | unanimous={ratio_unanimous:.2%} → {summary_path}")
    sys.exit(0 if status == "pass" else 1)


if __name__ == "__main__":
    main()
