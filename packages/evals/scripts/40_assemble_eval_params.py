#!/usr/bin/env python3
"""40 - Assemble eval params: merge tutti i normalized + few-shot pools.

Per ogni source:
- Carica normalized rows
- Carica few-shot examples (se shots > 0)
- Render prompt completo (few-shot + query)
- Assegna query_id deterministico (q_NNNNN), query_hash, language band, etc.
- Costruisce schema target completo (sans tokens, che li aggiunge 50_)

Output: data/final/evaluation_parameters_full.jsonl (tokens=0 placeholder, popolati da 50_)
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from brick_evals.fewshot import render_prompt, select_template
from brick_evals.io_utils import (
    configs_dir,
    data_dir,
    load_jsonl,
    load_yaml,
    save_jsonl,
)


def assemble():
    sources = load_yaml(configs_dir() / "sources.yaml")
    fewshot_dir = data_dir("fewshot_pools")
    norm_dir = data_dir("normalized")

    all_rows: list[dict] = []
    for sid, cfg in sources.items():
        if sid.startswith("_") or not isinstance(cfg, dict):
            continue
        norm_path = norm_dir / f"{sid}.jsonl"
        if not norm_path.exists():
            print(f"  [SKIP] {sid}: missing {norm_path.name}")
            continue
        rows_in = list(load_jsonl(norm_path))
        if not rows_in:
            print(f"  [SKIP] {sid}: 0 normalized rows")
            continue

        shots = cfg.get("shots", 5)
        few_shot_examples: list[dict] = []
        if shots > 0:
            fs_path = fewshot_dir / f"{sid}.json"
            if fs_path.exists():
                few_shot_examples = json.loads(fs_path.read_text())
            else:
                print(f"  [warn] {sid}: shots={shots} but no fewshot_pool/{sid}.json (will be 0-shot in practice)")
                shots = 0

        protocol = cfg.get("expected_protocol", "unknown")
        license_ = cfg.get("license", "unknown")
        gated = cfg.get("gated", False)

        for r in rows_in:
            raw_query = r["query"]
            template_id = (
                select_template(r["expected_answer"]["type"], r["source_label"], shots)
                if False
                else select_template(cfg["dimension"], r["source_label"], shots)
            )
            # Render prompt
            extras = {}
            if r["expected_answer"]["type"] == "mcq_letter":
                opts = r["expected_answer"]["payload"].get("options", [])
                extras["options_formatted"] = "\n".join(f"{chr(65 + i)}. {o}" for i, o in enumerate(opts))
            try:
                rendered_query = render_prompt(template_id, raw_query, few_shot_examples, **extras)
            except Exception as e:
                print(f"  [warn] render failed for {sid}: {e}; using raw query")
                rendered_query = raw_query

            row = {
                "query": rendered_query,
                "dimension": cfg["dimension"],
                "source": r.get("source_label", sid),
                "shots": shots,
                "input_tokens_qwen": 0,  # filled by 50_
                "input_tokens_deepseek": 0,
                "input_tokens_kimi": 0,
                "expected_answer": r["expected_answer"],
                "few_shot_examples": few_shot_examples,
                "evaluation_protocol_id": protocol,
                "gated": r.get("gated", gated),
                "license": r.get("license", license_),
                "length_band": r.get("length_band", "med"),
            }
            all_rows.append(row)

        print(f"  {sid:30s}: {len(rows_in)} rows assembled")

    # Sort deterministico (cross-version stability): stesso seed/ordine input riproducibile
    all_rows.sort(key=lambda r: (r["dimension"], r["source"], r["query"][:200]))

    # Assegna query_id
    for i, r in enumerate(all_rows):
        r["query_id"] = f"q_{i:05d}"

    out = data_dir("final") / "evaluation_parameters_full.jsonl"
    n = save_jsonl(out, all_rows)
    print(f"\nassembled {n} rows -> {out}")

    # Stratify summary
    from collections import Counter

    by_dim = Counter(r["dimension"] for r in all_rows)
    print("Distribution by dimension:")
    for d, c in sorted(by_dim.items()):
        print(f"  {d:25s} {c}")


if __name__ == "__main__":
    assemble()
