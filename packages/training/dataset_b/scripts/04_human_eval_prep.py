"""Sample 200 stratified queries for human (Claude) annotation.

Reads data/final/dataset_b_train.jsonl, writes data/human_eval/sample_200.csv
with empty score columns to be filled, plus a hidden gold reference for kappa.
"""

from __future__ import annotations

import argparse
import csv
import json
import random
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DIMS = [
    "instruction_following",
    "coding",
    "math_reasoning",
    "world_knowledge",
    "planning_agentic",
    "creative_synthesis",
]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", default=str(ROOT / "data" / "final" / "dataset_b_train.jsonl"))
    ap.add_argument("--output", default=str(ROOT / "data" / "human_eval" / "sample_200.csv"))
    ap.add_argument("--judge-ref", default=str(ROOT / "data" / "human_eval" / "judge_ref.json"))
    ap.add_argument("--n", type=int, default=200)
    ap.add_argument("--seed", type=int, default=42)
    args = ap.parse_args()

    records = []
    with Path(args.input).open() as f:
        for line in f:
            records.append(json.loads(line))
    by_split: dict[str, list[dict]] = {}
    for r in records:
        by_split.setdefault(r["split_type"], []).append(r)

    rng = random.Random(args.seed)
    target = {"single_skill": int(args.n * 0.5), "multi_skill": int(args.n * 0.4)}
    target["edge_case"] = args.n - target["single_skill"] - target["multi_skill"]
    sampled: list[dict] = []
    for split, n in target.items():
        pool = by_split.get(split, [])
        rng.shuffle(pool)
        sampled.extend(pool[:n])

    out_path = Path(args.output)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with out_path.open("w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["query_id", "split_type", "query"] + DIMS + ["notes"])
        for r in sampled:
            w.writerow([r["query_id"], r["split_type"], r["query"]] + ["" for _ in DIMS] + [""])

    ref = {r["query_id"]: r["scores_final"] for r in sampled}
    Path(args.judge_ref).write_text(json.dumps(ref, indent=2))
    print(f"[done] wrote {len(sampled)} rows to {out_path}; judge ref to {args.judge_ref}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
