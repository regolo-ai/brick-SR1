#!/usr/bin/env python3
"""Aggrega i risultati di valutazione (graded JSONL) in tabelle per il report.

Legge gli 8 file graded canonici di qwen3.5-9b + deepseek-v4-flash, calcola per
ogni (model, protocol-instance) i conteggi e le metriche di accuratezza, e scrive
`data/reports/evaluation_results.{csv,md}`.

Disambiguazione protocolli: `rubric_judge` e `tool_call_match` coprono due
dimensioni ciascuno (creative vs planning; BFCL single-turn vs BFCL multi-turn)
- la label viene derivata dal file di provenienza, non solo dal
campo `evaluation_protocol_id`.

Classificazione di `correct is None`:
  - `trunc`        : risposta vuota per troncamento (finish_reason=length) -
                     fallimento di misura del modello
  - `notattempted` : llm_judge_factual label C (SimpleQA NOT_ATTEMPTED) -
                     astensione semanticamente valida, NON un errore
  - `error`        : errore di inference/grading
  - `other`        : None non classificato

Metriche per riga:
  completion_rate      = (T+F) / n
  accuracy_conditional = T / (T+F)        # accuratezza sulle righe completate
  accuracy_overall     = T / n            # il None conta come non-corretto
                                          # (per factual: headline SimpleQA "correct %")

Uso:
  python scripts/130_aggregate_results.py
"""

from __future__ import annotations

import csv
import json
import sys
from collections import Counter
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]


# (model_alias, path_relativo_al_repo). La label di protocollo è derivata a
# runtime da evaluation_protocol_id + nome file (vedi protocol_label()).
FILE_SPECS: list[tuple[str, str]] = [
    ("qwen3.5-9b", "runs_individual/R1/qwen9b/outputs/qwen35_9b_full_graded_v2.jsonl"),
    ("qwen3.5-9b", "runs_individual/R1/qwen9b/outputs/qwen35_9b_llmjudge_graded.jsonl"),
    ("qwen3.5-9b", "data/inference/qwen3.5-9b/planning_full_graded.jsonl"),
    ("qwen3.5-9b", "data/inference/qwen3.5-9b/multi_turn_full_graded.jsonl"),
    ("deepseek-v4-flash", "data/inference/deepseek-v4-flash/dataset_a_deterministic_graded.jsonl"),
    ("deepseek-v4-flash", "data/inference/deepseek-v4-flash/dataset_a_llmjudge_graded.jsonl"),
    ("deepseek-v4-flash", "data/inference/deepseek-v4-flash/planning_full_graded.jsonl"),
    ("deepseek-v4-flash", "data/inference/deepseek-v4-flash/multi_turn_full_graded.jsonl"),
    # kimi2.6: deterministici + llmjudge + planning + multi-turn completati 2026-05-15.
    ("kimi2.6", "data/inference/kimi2.6/dataset_a_deterministic_graded.jsonl"),
    ("kimi2.6", "data/inference/kimi2.6/dataset_a_llmjudge_graded.jsonl"),
    ("kimi2.6", "data/inference/kimi2.6/planning_full_graded.jsonl"),
    ("kimi2.6", "data/inference/kimi2.6/multi_turn_full_graded.jsonl"),
]

# Ordine di presentazione delle protocol-instance + dimensione del paper.
PROTOCOL_ORDER: list[tuple[str, str, str]] = [
    # (label, dimension, source descrittivo)
    ("gsm8k_final_answer", "math_reasoning", "GSM8K"),
    ("math_equiv", "math_reasoning", "MATH-500 + AIME-2025"),
    ("ifeval_constraint_check", "instruction_following", "IFEval + IFBench"),
    ("lcb_unit_test", "coding", "LiveCodeBench-v6"),
    ("mcq_letter", "world_knowledge", "MMLU-Pro-Humanities"),
    ("llm_judge_factual", "world_knowledge", "SimpleQA"),
    ("rubric_judge:creative", "creative_synthesis", "EQ-Bench + LitBench + Custom"),
    ("rubric_judge:planning", "planning_agentic", "Planning-Custom"),
    ("tool_call_match:bfcl", "planning_agentic", "BFCL-v4 single-turn"),
    ("tool_call_match:bfcl_mt", "planning_agentic", "BFCL-v4 multi-turn"),
]

# Conteggi attesi per protocol-instance (assert hard, come gli altri stage pipeline).
EXPECTED_N: dict[str, int] = {
    "gsm8k_final_answer": 470,
    "math_equiv": 530,
    "ifeval_constraint_check": 841,
    "lcb_unit_test": 1000,
    "mcq_letter": 102,
    "llm_judge_factual": 700,
    "rubric_judge:creative": 696,
    "rubric_judge:planning": 335,
    "tool_call_match:bfcl": 500,
    "tool_call_match:bfcl_mt": 165,
}


def protocol_label(protocol: str, path: str) -> str:
    """Deriva la protocol-instance label da protocollo + file di provenienza."""
    if protocol == "rubric_judge":
        return "rubric_judge:planning" if "planning" in path else "rubric_judge:creative"
    if protocol == "tool_call_match":
        return "tool_call_match:bfcl_mt" if "multi_turn" in path else "tool_call_match:bfcl"
    return protocol


def classify_none(row: dict) -> str:
    """Classifica una riga con correct is None in trunc/notattempted/error/other."""
    gm = row.get("grader_meta") or {}
    if not isinstance(gm, dict):
        gm = {}
    reason = str(gm.get("reason") or "").lower()
    if "truncation" in reason or ("finish_reason=length" in reason):
        return "trunc"
    if gm.get("judge_label") == "C":
        return "notattempted"
    if "inference error" in reason or gm.get("error") or gm.get("checker_error"):
        return "error"
    if "error" in reason:
        return "error"
    return "other"


def main() -> int:
    # stats[(model, label)] = Counter + judge_cost
    stats: dict[tuple[str, str], Counter] = {}
    judge_cost: dict[tuple[str, str], float] = {}
    seen_models: set[str] = set()

    for model, rel in FILE_SPECS:
        path = REPO / rel
        if not path.exists():
            print(f"[WARN] file mancante, skip: {rel}", file=sys.stderr)
            continue
        n_lines = 0
        for line in path.open(encoding="utf-8"):
            line = line.strip()
            if not line:
                continue
            row = json.loads(line)
            n_lines += 1
            # sanity: model_name coerente
            mn = row.get("model_name")
            if mn:
                seen_models.add(mn)
            proto = row.get("evaluation_protocol_id") or "?"
            label = protocol_label(proto, rel)
            key = (model, label)
            c = stats.setdefault(key, Counter())
            judge_cost.setdefault(key, 0.0)
            correct = row.get("correct")
            if correct is True:
                c["true"] += 1
            elif correct is False:
                c["false"] += 1
            else:
                c["none"] += 1
                c[f"none_{classify_none(row)}"] += 1
            gm = row.get("grader_meta") or {}
            if isinstance(gm, dict):
                judge_cost[key] += float(gm.get("judge_cost_usd") or 0.0)
        print(f"[read] {rel}: {n_lines} righe")

    # --- assert conteggi attesi ---
    errors = []
    for (model, label), c in stats.items():
        exp = EXPECTED_N.get(label)
        tot = c["true"] + c["false"] + c["none"]
        if exp is not None and tot != exp:
            errors.append(f"  {model}/{label}: n={tot} atteso={exp}")
    if errors:
        print("[ASSERT FAIL] conteggi inattesi:", file=sys.stderr)
        print("\n".join(errors), file=sys.stderr)
        return 1
    print(f"[assert] conteggi OK; model_name visti: {sorted(seen_models)}")

    # --- costruzione righe tabella ---
    models = ["qwen3.5-9b", "deepseek-v4-flash", "kimi2.6"]
    rows = []
    for label, dimension, source in PROTOCOL_ORDER:
        for model in models:
            c = stats.get((model, label))
            if not c:
                continue
            t, f, none = c["true"], c["false"], c["none"]
            n = t + f + none
            graded = t + f
            comp = graded / n if n else 0.0
            acc_cond = t / graded if graded else 0.0
            acc_over = t / n if n else 0.0
            rows.append(
                {
                    "model": model,
                    "protocol": label,
                    "dimension": dimension,
                    "source": source,
                    "n": n,
                    "correct": t,
                    "incorrect": f,
                    "none_total": none,
                    "none_trunc": c["none_trunc"],
                    "none_notattempted": c["none_notattempted"],
                    "none_error": c["none_error"],
                    "none_other": c["none_other"],
                    "completion_rate": round(comp, 4),
                    "accuracy_conditional": round(acc_cond, 4),
                    "accuracy_overall": round(acc_over, 4),
                    "judge_cost_usd": round(judge_cost.get((model, label), 0.0), 4),
                }
            )

    # --- output CSV ---
    out_dir = REPO / "data" / "reports"
    out_dir.mkdir(parents=True, exist_ok=True)
    csv_path = out_dir / "evaluation_results.csv"
    fields = list(rows[0].keys())
    with csv_path.open("w", newline="", encoding="utf-8") as fcsv:
        w = csv.DictWriter(fcsv, fieldnames=fields)
        w.writeheader()
        w.writerows(rows)
    print(f"[write] {csv_path}")

    # --- output Markdown ---
    md_path = out_dir / "evaluation_results.md"
    total_cost = sum(judge_cost.values())
    with md_path.open("w", encoding="utf-8") as fmd:
        fmd.write("# Dataset A: Evaluation Results (qwen3.5-9b, deepseek-v4-flash, kimi2.6)\n\n")
        fmd.write("Generato da `scripts/130_aggregate_results.py`. ")
        fmd.write("`completion_rate`=(T+F)/n · `acc_cond`=T/(T+F) · `acc_over`=T/n.\n\n")
        fmd.write("| Model | Protocol | Dim | n | T | F | None (trunc/NA/err) | Compl. | Acc(cond) | Acc(all) |\n")
        fmd.write("|---|---|---|--:|--:|--:|---|--:|--:|--:|\n")
        for r in rows:
            none_detail = f"{r['none_total']} ({r['none_trunc']}/{r['none_notattempted']}/{r['none_error']})"
            fmd.write(
                f"| {r['model']} | {r['protocol']} | {r['dimension']} | {r['n']} | "
                f"{r['correct']} | {r['incorrect']} | {none_detail} | "
                f"{r['completion_rate']*100:.1f}% | {r['accuracy_conditional']*100:.1f}% | "
                f"{r['accuracy_overall']*100:.1f}% |\n"
            )
        fmd.write(f"\n**Costo LLM-judge totale**: ${total_cost:.2f}\n")
    print(f"[write] {md_path}")
    print(f"[done] {len(rows)} righe · judge cost totale ${total_cost:.2f}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
