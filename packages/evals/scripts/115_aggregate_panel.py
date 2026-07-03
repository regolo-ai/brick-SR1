#!/usr/bin/env python3
"""115 - Aggrega i graded file di più giudici LLM in un verdetto di panel.

Workflow panel (vedi skill `/llmevals`): si esegue `110_grade_inference.py` una volta
per giudice (`--judge-model`), producendo N graded file. Questo script li fonde per
`query_id` applicando **majority vote 2/3**:

  - protocollo judge (`rubric_judge` / `llm_judge_factual`): voto a maggioranza sui
    verdetti dei giudici. `None` = astensione (output non parsabile / truncation).
    Si vota solo sui non-None; <2 voti validi o tie 1-1 → `correct=None`.
  - protocollo deterministico (`tool_call_match`, ...): identico in tutti i file →
    passthrough dal primo file disponibile.

Output: un JSONL con una riga per `query_id`. Le righe judge ottengono i campi extra
`panel` (verdetto per giudice), `panel_vote` ("<accept>-<reject>"), `panel_cost_usd`.

Usage:
  python scripts/115_aggregate_panel.py \\
      --inputs a_graded.jsonl b_graded.jsonl c_graded.jsonl \\
      --output a_graded__panel.jsonl
"""

from __future__ import annotations

import argparse
import json
import sys
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

# Protocolli gradati da LLM-judge → soggetti a majority vote.
JUDGE_PROTOCOLS = {"rubric_judge", "llm_judge_factual"}


def majority_vote(verdicts: list[bool | None]) -> tuple[bool | None, str]:
    """Majority vote sui verdetti di N giudici.

    `None` = astensione (non conta). Si vota solo sui validi (non-None):
      - accept > reject → True
      - reject > accept → False
      - <2 voti validi, oppure tie con esattamente 2 validi → None

    Ritorna `(label, "<accepts>-<rejects>")` dove i conteggi sono SOLO sui validi.
    """
    valid = [v for v in verdicts if v is not None]
    accepts = sum(1 for v in valid if v is True)
    rejects = sum(1 for v in valid if v is False)
    vote_str = f"{accepts}-{rejects}"
    if len(valid) < 2:
        return None, vote_str
    if accepts > rejects:
        return True, vote_str
    if rejects > accepts:
        return False, vote_str
    return None, vote_str  # tie


def _judge_decision(row: dict) -> str | None:
    """Estrae la decisione testuale del giudice da una riga gradata."""
    meta = row.get("grader_meta") or {}
    return meta.get("judge_decision") or meta.get("judge_label")


def aggregate_row(query_id: str, rows: dict[str, dict]) -> dict:
    """Fonde le righe gradate dei giudici (dict judge_model -> graded row) per un query_id.

    `rows` può avere meno di N entry: un giudice mancante = astensione.
    """
    any_row = next(iter(rows.values()))
    protocol = any_row.get("evaluation_protocol_id")

    # Protocollo deterministico → passthrough (identico in tutti i file).
    if protocol not in JUDGE_PROTOCOLS:
        return dict(any_row)

    # Protocollo judge → majority vote.
    final, vote_str = majority_vote([r.get("correct") for r in rows.values()])

    panel: dict[str, dict] = {}
    panel_cost = 0.0
    for model, r in rows.items():
        meta = r.get("grader_meta") or {}
        cost = float(meta.get("judge_cost_usd") or 0.0)
        panel_cost += cost
        panel[model] = {
            "decision": _judge_decision(r),
            "correct": r.get("correct"),
            "raw": meta.get("judge_raw_response", ""),
            "cost_usd": cost,
        }

    out = {k: v for k, v in any_row.items() if k not in ("correct", "grader_meta")}
    out["correct"] = final
    out["panel"] = panel
    out["panel_vote"] = vote_str
    out["panel_cost_usd"] = panel_cost
    return out


def _load(path: Path) -> dict[str, dict]:
    rows: dict[str, dict] = {}
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            r = json.loads(line)
            rows[r["query_id"]] = r
    return rows


def _judge_model_of(rows: dict[str, dict], fallback: str) -> str:
    """Identifica il judge_model di un file dal primo grader_meta che ce l'ha."""
    for r in rows.values():
        meta = r.get("grader_meta") or {}
        if jm := meta.get("judge_model"):
            return jm
    return fallback  # file senza righe judge (improbabile) → usa il path


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="Aggrega graded file multi-giudice (majority vote 2/3)")
    p.add_argument("--inputs", nargs="+", required=True, type=Path, help="≥2 graded JSONL (uno per giudice)")
    p.add_argument("--output", required=True, type=Path, help="JSONL panel aggregato")
    args = p.parse_args(argv)

    if len(args.inputs) < 2:
        print("[FAIL] servono almeno 2 graded file")
        return 1
    for path in args.inputs:
        if not path.exists():
            print(f"[FAIL] input non trovato: {path}")
            return 1

    # Carica ogni file, indicizzato per query_id; chiave = judge_model.
    files: dict[str, dict[str, dict]] = {}
    for path in args.inputs:
        rows = _load(path)
        model = _judge_model_of(rows, fallback=str(path))
        files[model] = rows
        print(f"[panel] {path.name}: {len(rows)} righe (judge={model})")

    all_qids: set[str] = set()
    for rows in files.values():
        all_qids.update(rows.keys())

    args.output.parent.mkdir(parents=True, exist_ok=True)
    vote_dist: Counter = Counter()
    n_judge = n_passthrough = 0
    total_panel_cost = 0.0
    with open(args.output, "w", encoding="utf-8") as fo:
        for qid in sorted(all_qids):
            present = {m: files[m][qid] for m in files if qid in files[m]}
            agg = aggregate_row(qid, present)
            fo.write(json.dumps(agg, ensure_ascii=False, default=str) + "\n")
            if "panel" in agg:
                n_judge += 1
                vote_dist[agg["panel_vote"]] += 1
                total_panel_cost += agg.get("panel_cost_usd", 0.0)
            else:
                n_passthrough += 1

    print(f"\n[panel] DONE → {args.output}")
    print(f"  righe totali: {len(all_qids)}  (judge={n_judge}, passthrough={n_passthrough})")
    print(f"  panel_vote distribution: {dict(sorted(vote_dist.items()))}")
    print(f"  panel cost totale: ${total_panel_cost:.4f}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
