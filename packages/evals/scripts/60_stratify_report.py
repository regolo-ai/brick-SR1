#!/usr/bin/env python3
"""60 - Stratify report: markdown + JSON con distribuzioni per dimension/source/etc.

Asserzioni hard: count corretti, no duplicate query_id, schema valido.
"""

from __future__ import annotations

import json
import sys
from collections import Counter, defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from brick_evals.io_utils import data_dir, load_jsonl
from brick_evals.schema import validate_row


def percentiles(values: list[int], pcts: list[int]) -> dict[str, int]:
    if not values:
        return {f"p{p}": 0 for p in pcts}
    sv = sorted(values)
    out = {}
    for p in pcts:
        idx = max(0, min(len(sv) - 1, int(len(sv) * p / 100)))
        out[f"p{p}"] = sv[idx]
    return out


def main():
    in_path = data_dir("final") / "evaluation_parameters_full.jsonl"
    rows = list(load_jsonl(in_path))
    print(f"loaded {len(rows)} rows")

    # Schema validation
    schema_errors = []
    for i, r in enumerate(rows):
        errs = validate_row(r, allow_unmasked_token_count=True)
        if errs:
            schema_errors.append((i, r.get("query_id"), errs))
    if schema_errors:
        print(f"\n[FAIL] {len(schema_errors)} schema errors (showing first 5):")
        for i, qid, errs in schema_errors[:5]:
            print(f"  row {i} ({qid}): {errs}")

    # Asserzioni
    qids = [r["query_id"] for r in rows]
    dup_qids = [k for k, v in Counter(qids).items() if v > 1]
    queries = [r["query"][:200] for r in rows]  # tronca per dedup duplicate detection
    dup_queries = [k for k, v in Counter(queries).items() if v > 1]

    by_dim = Counter(r["dimension"] for r in rows)
    by_src = Counter(r["source"] for r in rows)
    by_len = Counter(r["length_band"] for r in rows)
    by_gated = Counter(r["gated"] for r in rows)
    by_lic = Counter(r["license"] for r in rows)
    by_proto = Counter(r["evaluation_protocol_id"] for r in rows)
    shots_dist = Counter(r["shots"] for r in rows)

    # Token stats per dim
    tokens_by_dim = defaultdict(list)
    for r in rows:
        tokens_by_dim[r["dimension"]].append(r["input_tokens_qwen"])

    md = []
    md.append("# Dataset A - Stratification Report\n")
    md.append(f"**Total rows:** {len(rows)}\n")
    md.append(f"**Duplicate query_id:** {len(dup_qids)}\n")
    md.append(f"**Duplicate queries (truncated 200):** {len(dup_queries)}\n")
    md.append(f"**Schema errors:** {len(schema_errors)}\n")

    md.append("\n## By dimension\n")
    for k, v in sorted(by_dim.items()):
        md.append(f"- `{k}`: {v}\n")

    md.append("\n## By source\n")
    for k, v in sorted(by_src.items()):
        md.append(f"- `{k}`: {v}\n")

    md.append("\n## By length_band\n")
    for k, v in sorted(by_len.items()):
        md.append(f"- `{k}`: {v}\n")

    md.append("\n## Gated\n")
    for k, v in sorted(by_gated.items()):
        md.append(f"- `{k}`: {v}\n")

    md.append("\n## By license\n")
    for k, v in sorted(by_lic.items()):
        md.append(f"- `{k}`: {v}\n")

    md.append("\n## By evaluation_protocol_id\n")
    for k, v in sorted(by_proto.items()):
        md.append(f"- `{k}`: {v}\n")

    md.append("\n## Shots distribution\n")
    for k, v in sorted(shots_dist.items()):
        md.append(f"- shots={k}: {v}\n")

    md.append("\n## Token stats (input_tokens_qwen) per dimension\n")
    md.append("| dimension | n | min | p50 | p95 | max |\n")
    md.append("|---|---|---|---|---|---|\n")
    for d, tks in sorted(tokens_by_dim.items()):
        if not tks:
            continue
        p = percentiles(tks, [50, 95])
        md.append(f"| {d} | {len(tks)} | {min(tks)} | {p['p50']} | {p['p95']} | {max(tks)} |\n")

    out_md = data_dir("reports") / "stratify.md"
    out_md.write_text("".join(md), encoding="utf-8")
    print(f"saved {out_md}")

    out_json = data_dir("reports") / "stratify.json"
    summary = {
        "total": len(rows),
        "by_dimension": dict(by_dim),
        "by_source": dict(by_src),
        "by_length_band": dict(by_len),
        "by_gated": {str(k): v for k, v in by_gated.items()},
        "by_license": dict(by_lic),
        "by_evaluation_protocol_id": dict(by_proto),
        "shots_distribution": dict(shots_dist),
        "duplicate_query_id": dup_qids,
        "duplicate_queries_count": len(dup_queries),
        "schema_errors_count": len(schema_errors),
    }
    out_json.write_text(json.dumps(summary, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"saved {out_json}")

    # Asserzioni hard
    fail = False
    if dup_qids:
        print(f"[FAIL] duplicate query_id: {len(dup_qids)}")
        fail = True
    if dup_queries:
        print(f"[WARN] duplicate queries (200-prefix): {len(dup_queries)} (può essere normale per IF templates)")
    if schema_errors:
        print(f"[FAIL] schema errors: {len(schema_errors)}")
        fail = True

    return 1 if fail else 0


if __name__ == "__main__":
    raise SystemExit(main())
