#!/usr/bin/env python3
"""10c - Materializza i 165 task BFCL multi-turn (scripted, no LLM user-sim).

Sorgente: file JSON Lines già presenti nel clone `external/bfcl/.../bfcl_eval/data/`
(scaricati con `git sparse-checkout` da gorilla). Per ogni task unisce il file
`BFCL_v4_multi_turn_<cat>.json` (question + env config) con il rispettivo
`possible_answer/BFCL_v4_multi_turn_<cat>.json` (ground_truth) sul campo `id`.

Strato di stratificazione: 50 base + 40 miss_func + 40 miss_param + 35 long_context = 165.
Composite (in `unused_datasets/`) escluso perché deprecato in BFCL v4.

Output: `data/raw/bfcl_v4_multi_turn.jsonl` (165 righe) + entry in lockfile.
"""

from __future__ import annotations

import json
import random
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from brick_evals.io_utils import data_dir, file_sha256, save_jsonl, utc_now_iso  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
BFCL_DATA = ROOT / "external" / "bfcl" / "berkeley-function-call-leaderboard" / "bfcl_eval" / "data"

QUOTES = {
    "base": 50,
    "miss_func": 40,
    "miss_param": 40,
    "long_context": 35,
}
SEED = 42


def _load_jsonl(path: Path) -> list[dict]:
    with open(path, encoding="utf-8") as f:
        return [json.loads(line) for line in f if line.strip()]


def _load_possible_answer(path: Path) -> dict[str, list[list[str]]]:
    out: dict[str, list[list[str]]] = {}
    for row in _load_jsonl(path):
        out[row["id"]] = row.get("ground_truth", [])
    return out


def main() -> int:
    if not BFCL_DATA.exists():
        print(f"[FAIL] BFCL clone not found at {BFCL_DATA}")
        print(
            "Run: cd external && git clone --filter=blob:none --sparse https://github.com/ShishirPatil/gorilla.git bfcl"
        )
        print("     cd bfcl && git sparse-checkout set berkeley-function-call-leaderboard")
        return 1

    rng = random.Random(SEED)
    all_rows: list[dict] = []
    for category, quota in QUOTES.items():
        q_path = BFCL_DATA / f"BFCL_v4_multi_turn_{category}.json"
        a_path = BFCL_DATA / "possible_answer" / f"BFCL_v4_multi_turn_{category}.json"
        if not q_path.exists() or not a_path.exists():
            print(f"[FAIL] missing {q_path.name} or {a_path.name}")
            return 1
        questions = _load_jsonl(q_path)
        answers = _load_possible_answer(a_path)

        # Sample deterministico per categoria
        rng.shuffle(questions)
        picked: list[dict] = []
        for q in questions:
            if q["id"] not in answers:
                continue
            picked.append(
                {
                    **q,
                    "ground_truth": answers[q["id"]],
                    "_category": f"multi_turn_{category}",
                    "_source_id": "bfcl_v4_multi_turn",
                }
            )
            if len(picked) >= quota:
                break
        if len(picked) < quota:
            print(f"[WARN] only {len(picked)}/{quota} available for {category}")
        all_rows.extend(picked)
        print(f"  {category}: picked {len(picked)} (quota {quota})")

    out_path = data_dir("raw") / "bfcl_v4_multi_turn.jsonl"
    n = save_jsonl(out_path, all_rows)
    sha = file_sha256(out_path)
    print(f"\nsaved {n} multi-turn tasks -> {out_path}")
    print(f"SHA256: {sha}")

    # Lockfile
    import yaml  # type: ignore

    lockfile = data_dir("reports") / "lockfile.yaml"
    entries = {}
    if lockfile.exists():
        with open(lockfile) as f:
            entries = yaml.safe_load(f) or {}
    entries["bfcl_v4_multi_turn"] = {
        "source": "external/bfcl/berkeley-function-call-leaderboard/bfcl_eval/data",
        "n": n,
        "sha256": sha,
        "quotes": QUOTES,
        "seed": SEED,
        "generated_at": utc_now_iso(),
    }
    with open(lockfile, "w") as f:
        yaml.safe_dump(entries, f, default_flow_style=False, sort_keys=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
