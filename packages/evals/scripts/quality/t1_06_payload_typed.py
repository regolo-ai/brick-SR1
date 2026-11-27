#!/usr/bin/env python3
"""T1-06: Payload typed validation per `expected_answer.type` discriminated union.

Schemas Draft 2020-12 per ogni type ammesso. Gate: 100% pass.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "src"))

from brick_evals.io_utils import data_dir, load_jsonl
from jsonschema import Draft202012Validator

# Schemas per expected_answer.payload, per type
# Based on schema.py allowed types + observed structure in normalizers
SCHEMAS = {
    "exact_match": {
        "type": "object",
        "required": ["final_answer"],
        "properties": {
            "final_answer": {"type": ["string", "number"]},
            "solution_text": {"type": ["string", "null"]},
        },
    },
    "math_equivalent": {
        "type": "object",
        "required": ["final_answer"],
        "properties": {
            "final_answer": {"type": ["string", "number"]},
            "solution_latex": {"type": ["string", "null"]},
        },
    },
    "test_cases": {
        "type": "object",
        "required": ["public_tests"],
        "properties": {
            "public_tests": {"type": ["array", "string"]},
            "private_tests": {"type": ["array", "string", "null"]},
            "starter_code": {"type": ["string", "null"]},
            "function_name": {"type": ["string", "null"]},
            "platform": {"type": ["string", "null"]},
            "difficulty": {"type": ["string", "null"]},
        },
    },
    "tool_call_match": {
        "type": "object",
        "required": ["ground_truth_calls"],
        "properties": {
            "ground_truth_calls": {"type": "array"},
            "function_specs": {"type": ["array", "null"]},
            "category": {"type": ["string", "null"]},
        },
    },
    "tool_call_trajectory": {
        "type": "object",
        "required": ["task_id", "domain"],
        "properties": {
            "task_id": {"type": "string"},
            "domain": {"type": "string"},
            "tools_available": {"type": ["array", "null"]},
            "annotator": {"type": ["integer", "string", "null"]},
        },
    },
    "rubric_judge": {
        "type": "object",
        "required": ["rubric_id"],
        "properties": {
            "rubric_id": {"type": "string"},
            "judge": {"type": ["string", "null"]},
            "genre_tag": {"type": ["string", "null"]},
            "validation_status": {"type": ["string", "null"]},
        },
    },
    "llm_judge_factual": {
        "type": "object",
        "required": ["answer"],
        "properties": {
            "answer": {"type": ["string", "array"]},
            "metadata": {"type": ["string", "object", "null"]},
        },
    },
    "gaia_exact_match": {
        "type": "object",
        "required": ["final_answer"],
        "properties": {"final_answer": {"type": ["string", "number"]}},
    },
    "ifeval_constraint": {
        "type": "object",
        "required": ["instruction_id_list"],
        "properties": {
            "instruction_id_list": {"type": "array"},
            "kwargs": {"type": ["array", "object", "null"]},
        },
    },
    "mcq_letter": {
        "type": "object",
        "required": ["answer_letter"],
        "properties": {
            "answer_letter": {"type": "string", "pattern": "^[A-Za-z]$"},
            "answer_idx": {"type": ["integer", "null"]},
            "options": {"type": ["array", "object", "null"]},
            "category": {"type": ["string", "null"]},
        },
    },
    "masked": {},
}

GATE_PRODUCTION = 1.0  # 100%


def main():
    rows = list(load_jsonl(data_dir("final") / "evaluation_parameters_full.jsonl"))
    n = len(rows)

    type_counts = {}
    type_errors: dict[str, list[dict]] = {}
    type_unknown: list[dict] = []

    validators = {t: Draft202012Validator(s) for t, s in SCHEMAS.items()}

    for r in rows:
        ea = r.get("expected_answer", {})
        t = ea.get("type")
        payload = ea.get("payload")
        type_counts[t] = type_counts.get(t, 0) + 1
        if t not in validators:
            type_unknown.append({"query_id": r["query_id"], "type": t})
            continue
        errs = list(validators[t].iter_errors(payload))
        if errs:
            type_errors.setdefault(t, []).append(
                {
                    "query_id": r["query_id"],
                    "source": r["source"],
                    "errors": [str(e.message)[:200] for e in errs[:3]],
                }
            )

    n_errors = sum(len(v) for v in type_errors.values()) + len(type_unknown)
    pass_ratio = 1 - (n_errors / n) if n else 0
    status = "pass" if pass_ratio >= GATE_PRODUCTION else "fail"

    report = {
        "check": "payload_typed",
        "n_rows": n,
        "n_errors": n_errors,
        "pass_ratio": round(pass_ratio, 4),
        "type_counts": type_counts,
        "type_unknown": type_unknown[:10],
        "errors_per_type": {k: {"n": len(v), "sample": v[:5]} for k, v in type_errors.items()},
        "threshold_production": "100% pass",
        "status": status,
    }

    out_path = data_dir("reports", "quality") / "payload.json"
    out_path.write_text(json.dumps(report, indent=2, ensure_ascii=False, default=str))
    print(f"[t1_06_payload_typed] {status} | errors={n_errors}/{n} ({pass_ratio:.2%} pass) → {out_path}")
    sys.exit(0 if status == "pass" else 1)


if __name__ == "__main__":
    main()
