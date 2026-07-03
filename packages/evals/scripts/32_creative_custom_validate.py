#!/usr/bin/env python3
"""32 - Creative custom validate: LLM-as-judge pre-filter via Regolo qwen3.5-122b.

Rubric esplicita:
- genre_tag balance (auto)
- length 200-2000 chars (auto)
- novel/non-templated (LLM)
- no toxic content (LLM)
- specific/judgeable (LLM)

Voto auto del judge {accept, reject, ambiguous}. Solo gli 'ambiguous' vanno a human review.

Input: data/creative_custom/generated.jsonl
Output: data/creative_custom/validated.jsonl (max cap iniziale 100)
       data/creative_custom/review.csv (per gli 'ambiguous')
"""

from __future__ import annotations

import csv
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from brick_evals.io_utils import data_dir, save_jsonl
from brick_evals.regolo_client import RegoloClient

CAP_INITIAL = 600  # rev.5: extended from 100 to 600 to replace LitBench drop
JUDGE_SYSTEM = """You evaluate creative writing prompts for an LLM benchmark.

Rubric:
1. Originality: is the prompt non-templated? (avoid generic "write a story about X")
2. Judgeability: does the prompt impose a specific measurable constraint?
3. Mood/voice: does it have a clear tone or stylistic constraint?
4. Safety: not toxic, illegal, sexually explicit
5. Prompt length: between 30 and 800 characters
6. Language: prompt MUST be written in English

Final decision (ONE word):
- "accept" if passes all criteria with high confidence
- "reject" if violates >=1 criterion clearly (including non-English)
- "ambiguous" if uncertain

Output: ONLY one of {accept, reject, ambiguous}. No commentary.
"""


def judge_one(client: RegoloClient, prompt: str, genre: str) -> str:
    user = f"Required genre: {genre}\n\nPrompt to evaluate:\n{prompt}\n\nDecision:"
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
    """Auto check (no LLM): length range. Ritorna 'reject' se fail."""
    p = row.get("prompt", "")
    n = len(p)
    if n < 30 or n > 800:
        return "reject"
    return None


def main():
    gen_path = data_dir("creative_custom") / "generated.jsonl"
    if not gen_path.exists():
        print(f"[SKIP] {gen_path} not found. Run 31_creative_custom_generate.py first.")
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
        decision = judge_one(client, r["prompt"], r.get("genre_tag", ""))
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

    # Save validated (cap to CAP_INITIAL)
    accepted_out = accepted[:CAP_INITIAL]
    for r in accepted_out:
        r["validation_status"] = "approved"
    n = save_jsonl(data_dir("creative_custom") / "validated.jsonl", accepted_out)

    # Write review.csv for ambiguous
    review_path = data_dir("creative_custom") / "review.csv"
    with open(review_path, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["id", "genre_tag", "length", "prompt", "accept_yn", "notes"])
        for r in ambiguous:
            w.writerow([r["id"], r.get("genre_tag", ""), len(r.get("prompt", "")), r["prompt"], "", ""])

    print(f"\nsaved {n} validated -> validated.jsonl")
    print(f"saved {len(ambiguous)} ambiguous -> review.csv (human review)")
    print(f"rejected: {rejected}")


if __name__ == "__main__":
    raise SystemExit(main())
