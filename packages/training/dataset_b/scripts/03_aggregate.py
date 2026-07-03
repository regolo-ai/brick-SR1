"""Aggregate per-judge scores into final dataset_b_train.jsonl.

Reads:  data/raw/queries_generated.jsonl, data/labels/judge_*.jsonl
Writes: data/final/dataset_b_train.jsonl

Computes mean across judges (skipping judges with parse_fail), flags disagreement
when max-min > threshold on any dimension. Optional --audit prints histogram + stats.
"""

from __future__ import annotations

import argparse
import json
import statistics
import sys
from collections import defaultdict
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


def load_jsonl(path: Path) -> list[dict]:
    out = []
    with path.open() as f:
        for line in f:
            try:
                out.append(json.loads(line))
            except Exception:
                continue
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--queries", default=str(ROOT / "data" / "raw" / "queries_generated.jsonl"))
    ap.add_argument("--labels-dir", default=str(ROOT / "data" / "labels"))
    ap.add_argument("--output", default=str(ROOT / "data" / "final" / "dataset_b_train.jsonl"))
    ap.add_argument("--disagreement-threshold", type=float, default=0.3)
    ap.add_argument("--min-judges", type=int, default=2)
    ap.add_argument("--audit", action="store_true")
    args = ap.parse_args()

    queries_by_id = {q["query_id"]: q for q in load_jsonl(Path(args.queries))}

    judge_files = sorted(Path(args.labels_dir).glob("judge_*.jsonl"))
    if not judge_files:
        print("[err] no judge files found", file=sys.stderr)
        return 2

    scores_by_id: dict[str, dict[str, dict[str, float]]] = defaultdict(dict)
    for jf in judge_files:
        judge_name = jf.stem.replace("judge_", "")
        for rec in load_jsonl(jf):
            if "scores" not in rec:
                continue
            scores_by_id[rec["query_id"]][judge_name] = rec["scores"]

    out_path = Path(args.output)
    out_path.parent.mkdir(parents=True, exist_ok=True)

    n_written = 0
    n_disagreement = 0
    dim_hist = {d: defaultdict(int) for d in DIMS}
    coverage = defaultdict(int)

    with out_path.open("w") as fout:
        for qid, q in queries_by_id.items():
            per_judge = scores_by_id.get(qid, {})
            if len(per_judge) < args.min_judges:
                continue
            coverage[len(per_judge)] += 1
            scores_final = {}
            disagreement = False
            for d in DIMS:
                vals = [s[d] for s in per_judge.values() if d in s]
                if not vals:
                    scores_final[d] = 0.0
                    continue
                scores_final[d] = round(statistics.fmean(vals), 4)
                if max(vals) - min(vals) > args.disagreement_threshold:
                    disagreement = True
                bucket = round(scores_final[d] * 10) / 10
                dim_hist[d][bucket] += 1
            if disagreement:
                n_disagreement += 1
            rec = {
                "query_id": qid,
                "query": q["query"],
                "split_type": q["split_type"],
                "target_dimensions": q.get("target_dimensions", []),
                "edge_type": q.get("edge_type"),
                "scores_final": scores_final,
                "scores_per_judge": per_judge,
                "disagreement": disagreement,
                "generator": q.get("generator", ""),
            }
            fout.write(json.dumps(rec, ensure_ascii=False) + "\n")
            n_written += 1

    summary = {
        "total_written": n_written,
        "disagreement_count": n_disagreement,
        "disagreement_rate": round(n_disagreement / max(n_written, 1), 4),
        "judge_coverage": dict(coverage),
        "judges_used": [jf.stem.replace("judge_", "") for jf in judge_files],
    }
    print(json.dumps(summary, indent=2))
    Path(out_path.parent / "aggregate_summary.json").write_text(json.dumps(summary, indent=2))

    if args.audit:
        print("\n=== Score histogram (bucketed at 0.1) ===")
        for d in DIMS:
            print(f"\n{d}:")
            for b in sorted(dim_hist[d]):
                print(f"  {b:.1f} -> {dim_hist[d][b]}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
