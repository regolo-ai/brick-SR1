#!/usr/bin/env python3
"""Aggrega i risultati del panel-3-judge per agentic planning (rubric_judge).

Per ognuno dei 3 modelli pool legge:
  - `planning_full_graded.jsonl`            → judge A: openai/gpt-5.4-mini (canonical)
  - `planning_full_graded__mistral.jsonl`   → judge B: mistralai/mistral-small-2603
  - `planning_full_graded__glm.jsonl`       → judge C: z-ai/glm-5-turbo
  - `planning_full_graded__panel.jsonl`     → aggregato majority-vote 2/3 (da 115)

Calcola per ogni judge individuale + panel:
  - T / F / None (abstention)
  - accuracy conditional = T / (T+F)
  - accuracy overall     = T / 335

Per il panel calcola anche la distribuzione `panel_vote` (3-0/2-1/1-2/0-3/1-1).

Output: `data/reports/panel_results.{csv,md}`.

Uso:
  python scripts/131_panel_report.py
"""

from __future__ import annotations

import csv
import json
import sys
from collections import Counter
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
N_PC = 335  # numero totale di righe rubric_judge:planning attese

MODELS = ["qwen3.5-9b", "deepseek-v4-flash", "kimi2.6"]

# (judge_alias, file_suffix). "single" = file gpt-5.4-mini canonical (suffix vuoto).
JUDGE_FILES: list[tuple[str, str]] = [
    ("gpt-5.4-mini", "planning_full_graded.jsonl"),
    ("mistral-small-2603", "planning_full_graded__mistral.jsonl"),
    ("glm-5-turbo", "planning_full_graded__glm.jsonl"),
    ("panel-2of3", "planning_full_graded__panel.jsonl"),
]


def count_pc(path: Path) -> tuple[int, int, int, float, Counter]:
    """Ritorna (T, F, None, cost, vote_counter) per le righe rubric_judge in path."""
    t = f = n = 0
    cost = 0.0
    votes: Counter = Counter()
    if not path.exists():
        return t, f, n, cost, votes
    with path.open(encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            r = json.loads(line)
            if r.get("evaluation_protocol_id") != "rubric_judge":
                continue
            c = r.get("correct")
            if c is True:
                t += 1
            elif c is False:
                f += 1
            else:
                n += 1
            gm = r.get("grader_meta") or {}
            if isinstance(gm, dict):
                cost += float(gm.get("judge_cost_usd") or 0.0)
            cost += float(r.get("panel_cost_usd") or 0.0)
            v = r.get("panel_vote")
            if v:
                votes[v] += 1
    return t, f, n, cost, votes


def main() -> int:
    rows: list[dict] = []
    panel_votes_by_model: dict[str, Counter] = {}

    for model in MODELS:
        for judge_label, filename in JUDGE_FILES:
            path = REPO / "data" / "inference" / model / filename
            t, f, n, cost, votes = count_pc(path)
            tot = t + f + n
            if tot == 0:
                print(f"[WARN] missing or empty: {path}", file=sys.stderr)
                continue
            graded = t + f
            acc_cond = t / graded if graded else 0.0
            acc_over = t / N_PC if N_PC else 0.0
            rows.append(
                {
                    "model": model,
                    "judge": judge_label,
                    "n": tot,
                    "true": t,
                    "false": f,
                    "abstention": n,
                    "acc_conditional": round(acc_cond, 4),
                    "acc_overall": round(acc_over, 4),
                    "cost_usd": round(cost, 4),
                }
            )
            if judge_label == "panel-2of3":
                panel_votes_by_model[model] = votes
            print(f"[read] {model}/{judge_label}: T={t} F={f} None={n} cost=${cost:.4f}")

    out_dir = REPO / "data" / "reports"
    out_dir.mkdir(parents=True, exist_ok=True)

    csv_path = out_dir / "panel_results.csv"
    fields = list(rows[0].keys())
    with csv_path.open("w", newline="", encoding="utf-8") as fcsv:
        w = csv.DictWriter(fcsv, fieldnames=fields)
        w.writeheader()
        w.writerows(rows)
    print(f"[write] {csv_path}")

    # Markdown report
    md_path = out_dir / "panel_results.md"
    with md_path.open("w", encoding="utf-8") as fmd:
        fmd.write("# Three-judge panel: agentic planning (`rubric_judge:planning`)\n\n")
        fmd.write(
            "Three cross-provider judges (gpt-5.4-mini, mistral-small-2603, glm-5-turbo) "
            "applied to the 335 `rubric_judge`~(planning) queries per model. Each judge "
            "runs at temperature 0.0 with the identical rubric prompt. The `panel-2of3` "
            "row aggregates by majority vote on the two-of-three valid (non-abstention) "
            "verdicts; ties and <2 valid votes resolve to `correct=None`.\n\n"
        )
        fmd.write("## Per-judge accuracy\n\n")
        fmd.write("| Model | Judge | T | F | None | Acc(cond) | Acc(all) | Cost |\n")
        fmd.write("|---|---|--:|--:|--:|--:|--:|--:|\n")
        for r in rows:
            fmd.write(
                f"| {r['model']} | {r['judge']} | {r['true']} | {r['false']} | "
                f"{r['abstention']} | {r['acc_conditional']*100:.1f}% | "
                f"{r['acc_overall']*100:.1f}% | ${r['cost_usd']:.4f} |\n"
            )
        fmd.write("\n## Panel vote distribution (T-F counts on the 3 judges)\n\n")
        fmd.write(
            "Format `T-F`: number of accept votes minus reject votes among the 3 judges; "
            "`1-1` = only 2 valid votes with tie (abstention).\n\n"
        )
        all_keys = sorted({k for v in panel_votes_by_model.values() for k in v.keys()})
        fmd.write("| Model | " + " | ".join(all_keys) + " |\n")
        fmd.write("|---" + "|--:" * len(all_keys) + "|\n")
        for model in MODELS:
            votes = panel_votes_by_model.get(model, Counter())
            cells = [str(votes.get(k, 0)) for k in all_keys]
            fmd.write(f"| {model} | " + " | ".join(cells) + " |\n")
        fmd.write(
            "\nPanel cost totale: ${:.4f}\n".format(sum(r["cost_usd"] for r in rows if r["judge"] == "panel-2of3"))
        )
    print(f"[write] {md_path}")
    print(f"[done] {len(rows)} righe ({len(MODELS)} modelli × {len(JUDGE_FILES)} giudici)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
