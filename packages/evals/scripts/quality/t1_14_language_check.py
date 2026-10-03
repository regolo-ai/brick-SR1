#!/usr/bin/env python3
"""T1-14: Language detection — verifica che tutte le query siano in inglese.

Usa euristica leggera (no LLM, no heavy deps): conteggio parole con frequency-list
per riconoscere italiano residuo (es: "il", "che", "di", "della", "essere", ecc.).
Più strict: flag se ≥3 parole italiane top-100 frequenza in primi 200 char della query.

Gate production: 0 query in lingua diversa da English.
"""

from __future__ import annotations

import json
import re
import sys
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "src"))

from brick_evals.dedup import extract_actual_query
from brick_evals.io_utils import data_dir, load_jsonl

GATE_PRODUCTION = 0
MIN_HITS = 3

# Top italian function words distinctive (not English)
IT_DISTINCTIVE = {
    "che",
    "della",
    "delle",
    "dei",
    "del",
    "essere",
    "sono",
    "siamo",
    "questo",
    "questa",
    "questi",
    "queste",
    "perché",
    "perche",
    "tuttavia",
    "comunque",
    "infatti",
    "quando",
    "sempre",
    "italiano",
    "italiana",
    "scrivi",
    "rispondi",
    "domanda",
    "risposta",
    "esempio",
    "problema",
    "soluzione",
    "ragionamento",
    "istruzione",
    "ricavo",
    "fatturato",
    "deve",
    "devono",
    "voglio",
    "una",
    "uno",
    "gli",
    "lo",
    "quindi",
    "poi",
    "vendite",
    "agenda",
    "settimanale",
    "calcolare",
    "filtrare",
    "ambientato",
    "futuro",
    "dove",
    "lusso",
    "cittadini",
    "monologo",
    "interiore",
    "archivista",
    "diario",
}

SKIP = set()


def count_italian_hits(text: str) -> tuple[int, list[str]]:
    """Returns (count, words) of distinctive italian words found in text."""
    words = re.findall(r"\b[a-zàèéìòù]+\b", text.lower())
    found = [w for w in words if w in IT_DISTINCTIVE and w not in SKIP]
    return len(found), found


def main():
    rows = list(load_jsonl(data_dir("final") / "evaluation_parameters_full.jsonl"))
    n = len(rows)

    flagged = []
    by_source = defaultdict(int)

    for r in rows:
        if r.get("query") == "<masked>":
            continue
        actual = extract_actual_query(r["query"])[:1500]
        n_hits, words = count_italian_hits(actual)
        if n_hits >= MIN_HITS:
            by_source[r["source"]] += 1
            flagged.append(
                {
                    "query_id": r["query_id"],
                    "source": r["source"],
                    "hits": n_hits,
                    "words": list(set(words))[:10],
                    "snippet": actual[:200],
                }
            )

    n_flagged = len(flagged)
    status = "pass" if n_flagged <= GATE_PRODUCTION else "fail"

    report = {
        "check": "language_check",
        "config": {"min_hits": MIN_HITS, "gate": GATE_PRODUCTION},
        "n_rows": n,
        "n_flagged": n_flagged,
        "by_source": dict(by_source),
        "sample": flagged[:30],
        "threshold_production": f"<={GATE_PRODUCTION} non-English query",
        "status": status,
    }

    out_path = data_dir("reports", "quality") / "language.json"
    out_path.write_text(json.dumps(report, indent=2, ensure_ascii=False))
    print(f"[t1_14_language_check] {status} | flagged={n_flagged} → {out_path}")
    sys.exit(0 if status == "pass" else 1)


if __name__ == "__main__":
    main()
