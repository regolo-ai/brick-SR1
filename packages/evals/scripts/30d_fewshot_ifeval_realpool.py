#!/usr/bin/env python3
"""30d - IFEval fewshot from real test pool + LLM-generated answers.

Strategy:
- Pick 5 diverse rows from google/IFEval test split (different constraint types)
- For each prompt, ask Regolo qwen3.5-122b to write an answer respecting BOTH
  the prompt content AND the constraint (no template hardcoding)
- Verify programmatically the constraint where possible; retry if fail

Output: data/fewshot_pools/ifeval.json + lockfile.
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from brick_evals.io_utils import data_dir, file_sha256, load_jsonl, utc_now_iso
from brick_evals.regolo_client import RegoloClient

K_KEEP = 5
SEED = 42
MAX_RETRY = 3

# Prefer rows with these constraint types (diversity)
TARGET_TYPES = [
    "length_constraints:number_words",
    "change_case:english_capital",
    "punctuation:no_comma",
    "keywords:existence",
    "format:title",
    "language:response_language",
    "detectable_format:number_bullet_lists",
]


def verify_constraint(instr_id: str, kwargs: dict, answer: str) -> bool:
    """Programmatic verifier for common IFEval constraints. Conservative: True if unsure."""
    if "length_constraints:number_words" in instr_id:
        n_required = kwargs.get("num_words")
        if n_required is None:
            return True
        relation = (kwargs.get("relation") or "exactly").lower()
        n_actual = len(answer.split())
        if "at least" in relation:
            return n_actual >= n_required
        if "less than" in relation:
            return n_actual < n_required
        return n_actual == n_required
    if "change_case:english_capital" in instr_id:
        return answer.upper() == answer
    if "change_case:english_lowercase" in instr_id:
        return answer.lower() == answer
    if "punctuation:no_comma" in instr_id:
        return "," not in answer
    if "keywords:existence" in instr_id:
        keywords = kwargs.get("keywords") or []
        return all(kw.lower() in answer.lower() for kw in keywords)
    if "format:title" in instr_id:
        return bool(re.search(r"<<.+?>>", answer))
    return True


EXCLUDE_CONSTRAINT_PREFIXES = (
    "combination:repeat_prompt",  # would leak our meta-prompt
    "combination:repeat_request",
)


def select_diverse_rows(rows: list[dict]) -> list[dict]:
    """Pick K_KEEP rows with maximally diverse constraint types. Skip ones that would leak meta-prompt."""
    seen_types = set()
    selected = []
    for r in rows:
        ids = r.get("instruction_id_list") or []
        # Skip rows with problematic constraint types
        if any(any(p in id_ for p in EXCLUDE_CONSTRAINT_PREFIXES) for id_ in ids):
            continue
        matched = None
        for t in TARGET_TYPES:
            if any(t in id_ for id_ in ids):
                matched = t
                break
        if not matched or matched in seen_types:
            continue
        prompt = r.get("prompt") or r.get("instruction")
        if not prompt or len(prompt) < 30 or len(prompt) > 600:
            continue
        selected.append(r)
        seen_types.add(matched)
        if len(selected) >= K_KEEP:
            break
    return selected


GEN_PROMPT = """You are answering an IFEval-style instruction with verifiable constraints.

INSTRUCTION:
{instruction}

CRITICAL RULES:
- Write an answer that ADDRESSES the instruction's content directly.
- Strictly satisfy ALL constraints (word counts, capitalization, format, etc.).
- Output ONLY the final answer, no preamble, no markdown fences, no commentary.

ANSWER:"""


def main():
    raw_path = data_dir("raw") / "ifeval.jsonl"
    if not raw_path.exists():
        print(f"[30d] missing {raw_path}: run 10_download.py first")
        sys.exit(1)

    rows = list(load_jsonl(raw_path))
    print(f"[30d] loaded {len(rows)} IFEval rows")

    selected = select_diverse_rows(rows)
    print(f"[30d] selected {len(selected)} rows: {[r.get('instruction_id_list') for r in selected]}")

    client = RegoloClient()
    examples = []
    for i, r in enumerate(selected):
        prompt = r.get("prompt") or r.get("instruction")
        ids = r.get("instruction_id_list") or []
        kwargs_list = r.get("kwargs") or []
        kwargs = kwargs_list[0] if kwargs_list else {}
        first_id = ids[0] if ids else ""

        answer = ""
        for attempt in range(MAX_RETRY):
            try:
                ans = client.text(
                    GEN_PROMPT.format(instruction=prompt),
                    system="Output only the answer that satisfies ALL constraints. No preamble.",
                    temperature=0.5,
                    max_tokens=2048,
                )
                if verify_constraint(first_id, kwargs, ans):
                    answer = ans
                    break
                else:
                    print(f"  [{i+1}/{len(selected)}] attempt {attempt+1} failed verifier ({first_id})")
            except Exception as e:
                print(f"  [{i+1}/{len(selected)}] attempt {attempt+1} api error: {type(e).__name__}: {str(e)[:120]}")
        if not answer:
            answer = ans  # best effort

        print(f"  [{i+1}/{len(selected)}] {first_id} → answer ok={verify_constraint(first_id, kwargs, answer)}")
        examples.append(
            {
                "question": prompt,
                "reasoning": "",
                "final_answer": answer,
                "options_formatted": None,
            }
        )

    out_path = data_dir("fewshot_pools") / "ifeval.json"
    out_path.write_text(json.dumps(examples, ensure_ascii=False, indent=2), encoding="utf-8")
    sha = file_sha256(out_path)
    print(f"[30d] saved {len(examples)} examples → {out_path}")
    print(f"[30d] SHA256: {sha}")

    import yaml

    lockfile = data_dir("reports") / "lockfile.yaml"
    entries = {}
    if lockfile.exists():
        with open(lockfile) as f:
            entries = yaml.safe_load(f) or {}
    entries["fewshot_synthetic_ifeval"] = {
        "model": "real-pool google/IFEval test + qwen3.5-122b@regolo answer + verifier (rev.4 v3)",
        "n": len(examples),
        "sha256": sha,
        "regenerated_at": utc_now_iso(),
    }
    with open(lockfile, "w") as f:
        yaml.safe_dump(entries, f, default_flow_style=False, sort_keys=True)


if __name__ == "__main__":
    main()
