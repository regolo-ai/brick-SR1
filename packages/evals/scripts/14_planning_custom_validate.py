#!/usr/bin/env python3
"""Validate generated planning tasks using an explicit Regolo judge rubric: realism, multiple steps, measurable constraints, clear goals and safety. Write validated JSONL and ambiguous cases for human review, capped at 335 tasks."""

from __future__ import annotations

import csv
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from brick_evals.io_utils import data_dir, save_jsonl
from brick_evals.regolo_client import RegoloClient

CAP_INITIAL = 335

JUDGE_SYSTEM = "Evaluate agentic planning tasks for an LLM benchmark.\nEvery criterion must hold:\n1. Realistic professional scenario, not fantasy.\n2. Clearly requires at least three planning steps.\n3. Measurable constraints: budget, deadlines, limited resources, rules or explicit dependencies.\n4. Specific, measurable goal.\n5. No toxic, illegal or sexually explicit content.\n6. Length between 100 and 1000 characters.\nReturn only accept if all criteria clearly pass, reject if any clearly fails, or ambiguous if uncertain. No commentary."


def judge_one(client: RegoloClient, prompt: str, category: str) -> str:
    user = f"Expected category: {category}\n\nTask to evaluate:\n{prompt}\n\nDecision:"
    try:
        out = client.text(user, system=JUDGE_SYSTEM, temperature=0.1, max_tokens=10).strip().lower()
        for tag in ("accept", "reject", "ambiguous"):
            if tag in out:
                return tag
        return "ambiguous"
    except Exception as e:
        print(f"  [warn] judge failed: {type(e).__name__}: {str(e)[:80]}")
        return "ambiguous"


def auto_check(row: dict) -> str | None:
    p = row.get("prompt", "")
    n = len(p)
    if n < 80 or n > 1200:
        return "reject"
    return None


def main():
    gen_path = data_dir("planning_custom") / "generated.jsonl"
    if not gen_path.exists():
        print(f"[SKIP] {gen_path} not found. Run 13_planning_custom_generate.py first.")
        return 1

    rows = []
    with open(gen_path) as f:
        for line in f:
            line = line.strip()
            if line:
                rows.append(json.loads(line))

    if not rows:
        print("[SKIP] generated.jsonl is empty.")
        return 1

    print(f"loaded {len(rows)} candidates")

    client = RegoloClient()
    accepted = []
    ambiguous = []
    rejected = 0

    for i, r in enumerate(rows):
        if a := auto_check(r):
            r["validation_status"] = a
            rejected += 1
            continue
        decision = judge_one(client, r["prompt"], r.get("category", ""))
        r["validation_status"] = decision
        r["judge_model"] = "qwen3.5-122b@regolo"
        if decision == "accept":
            accepted.append(r)
        elif decision == "ambiguous":
            ambiguous.append(r)
        else:
            rejected += 1
        if (i + 1) % 25 == 0:
            print(f"  progress: {i + 1}/{len(rows)} | accept={len(accepted)} ambig={len(ambiguous)} reject={rejected}")
        if len(accepted) >= CAP_INITIAL:
            print(f"  CAP_INITIAL ({CAP_INITIAL}) reached; stopping.")
            break

    accepted_out = accepted[:CAP_INITIAL]
    for r in accepted_out:
        r["validation_status"] = "approved"
    n = save_jsonl(data_dir("planning_custom") / "validated.jsonl", accepted_out)

    review_path = data_dir("planning_custom") / "review.csv"
    with open(review_path, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["id", "category", "length", "prompt", "accept_yn", "notes"])
        for r in ambiguous:
            w.writerow([r["id"], r.get("category", ""), len(r.get("prompt", "")), r["prompt"], "", ""])

    print(f"\nsaved {n} validated -> validated.jsonl")
    print(f"saved {len(ambiguous)} ambiguous -> review.csv")
    print(f"rejected: {rejected}")


if __name__ == "__main__":
    raise SystemExit(main())
