#!/usr/bin/env python3
"""13 - Planning custom generate: 400 task di planning agentic via Regolo qwen3.5-122b.

Tipologie bilanciate (planning task richiedono multi-step + tool selection + state tracking):
- travel-planning, project-management, technical-debug, data-analysis,
  customer-service, research-investigation, scheduling-optimization, supply-chain.

Output: data/planning_custom/generated.jsonl + SHA256 in lockfile.
"""

from __future__ import annotations

import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from brick_evals.io_utils import data_dir, file_sha256, save_jsonl, utc_now_iso
from brick_evals.regolo_client import RegoloClient

CATEGORIES = [
    "travel-planning",
    "project-management",
    "technical-debug",
    "data-analysis",
    "customer-service",
    "research-investigation",
    "scheduling-optimization",
    "supply-chain",
]

TARGET_GENERATIONS = 400  # overhead ~20% per cap 335
PER_CATEGORY = TARGET_GENERATIONS // len(CATEGORIES)  # 50/categoria

SYSTEM_PROMPT = """You are a curator of agentic planning tasks for an LLM benchmark.
Generate ONE realistic task that requires the model to:
1. Understand a concrete goal in a specific scenario
2. Plan multi-step steps (3-7 steps)
3. Consider constraints, dependencies, edge cases
4. Optionally select appropriate tools/resources (you may suggest available tools/APIs/datasets)

Category: {category}

Constraints:
- Realistic scenario (no fantasy)
- Explicit measurable constraints (budget, deadline, limited resources, rules)
- Clear achievable goal
- Prompt length: 100-700 characters
- The task MUST be written in English.
- Output ONLY the task, no meta-commentary, no prefixes like "Task:" or "Question:".
"""


def gen_one(client: RegoloClient, category: str) -> str:
    sys_p = SYSTEM_PROMPT.format(category=category)
    user_p = f"Generate one agentic planning task in category '{category}'. Output only the task, in English."
    return client.text(user_p, system=sys_p, temperature=0.9, max_tokens=500).strip()


def main():
    out_path = data_dir("planning_custom") / "generated.jsonl"

    rows: list[dict] = []
    if out_path.exists():
        with open(out_path, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line:
                    rows.append(json.loads(line))

    seen_hashes = {hash(r.get("prompt", "")) for r in rows}
    counts_by_cat = {c: sum(1 for r in rows if r.get("category") == c) for c in CATEGORIES}

    if len(rows) >= TARGET_GENERATIONS:
        print(f"already have {len(rows)} >= target {TARGET_GENERATIONS}; nothing to do.")
        return 0

    client = RegoloClient()
    print(f"target {TARGET_GENERATIONS} generations across {len(CATEGORIES)} categories ({PER_CATEGORY}/cat)")

    for cat in CATEGORIES:
        while counts_by_cat[cat] < PER_CATEGORY:
            try:
                prompt = gen_one(client, cat)
                if not prompt or hash(prompt) in seen_hashes:
                    continue
                row = {
                    "id": f"planning_custom_{len(rows):04d}",
                    "prompt": prompt,
                    "category": cat,
                    "generated_by": "qwen3.5-122b@regolo",
                    "generated_at": utc_now_iso(),
                }
                rows.append(row)
                seen_hashes.add(hash(prompt))
                counts_by_cat[cat] += 1
                if len(rows) % 25 == 0:
                    save_jsonl(out_path, rows)
                    print(
                        f"  progress: {len(rows)}/{TARGET_GENERATIONS} (cat={cat} {counts_by_cat[cat]}/{PER_CATEGORY})"
                    )
            except Exception as e:
                print(f"  [warn] gen_one failed ({cat}): {type(e).__name__}: {str(e)[:120]}")
                time.sleep(2)
                continue

    n = save_jsonl(out_path, rows)
    sha = file_sha256(out_path)
    print(f"\nsaved {n} prompts -> {out_path}")
    print(f"SHA256: {sha}")

    # Lockfile entry
    import yaml

    lockfile = data_dir("reports") / "lockfile.yaml"
    entries = {}
    if lockfile.exists():
        with open(lockfile) as f:
            entries = yaml.safe_load(f) or {}
    entries["planning_custom_generated"] = {
        "model": "qwen3.5-122b@regolo",
        "n": n,
        "sha256": sha,
        "generated_at": utc_now_iso(),
        "categories": list(CATEGORIES),
    }
    with open(lockfile, "w") as f:
        yaml.safe_dump(entries, f, default_flow_style=False, sort_keys=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
