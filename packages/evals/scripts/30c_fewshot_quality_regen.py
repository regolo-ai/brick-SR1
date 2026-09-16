#!/usr/bin/env python3
"""Regenerate low-scoring few-shot pools. Generate twelve candidates, score five quality axes, then keep the best five meeting the 4.0 threshold, or the best available five if insufficient candidates qualify. Save each pool and its SHA256 provenance."""

from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from brick_evals.io_utils import data_dir, file_sha256, utc_now_iso
from brick_evals.judge import Judge
from brick_evals.regolo_client import RegoloClient

K_KEEP = 5
N_CANDIDATES = 12
MIN_SCORE = 4.0

SPECS_FULL = {
    "aime_2025": {
        "system": "Curate AIME competition mathematics problems. Return JSON only.",
        "generate_prompt": 'Generate exactly one AIME-style problem with a unique, well-defined integer answer from 0 to 999. Medium-high difficulty; clear step-by-step reasoning verified by calculations. Do not claim the problem is ill-posed or add assumptions. Choose number theory, combinatorics, geometry, algebra or probability. Return only question (English, 150-300 characters), reasoning (English, 300-700 characters with calculations) and final_answer (integer string). Historical style anchor:\n{\n  "question": "Find the number of ordered pairs (a,b) of positive integers with a<=b<=100 such that a*b/gcd(a,b)^2 is a perfect square.",\n  "reasoning": "Let d=gcd(a,b), a=dx, b=dy with gcd(x,y)=1. Then a*b/d^2 = xy. xy is a perfect square iff x=y (impossible since gcd=1 forces x=y=1) or x and y are themselves squares. Counting pairs with a<=b<=100: ...",\n  "final_answer": "203"\n}',
    },
    "livecodebench_v6": {
        "system": "Curate LeetCode/competitive-programming problems. Return JSON only.",
        "generate_prompt": "Generate exactly one LiveCodeBench/LeetCode-style problem. Provide explicit input/output specifications and examples. Return JSON with question, reasoning (English algorithm, time/space complexity and edge cases) and final_answer (correct executable Python function with a short docstring). Vary arrays, strings, DP, greedy, graphs, mathematics, hash tables, two pointers and sliding windows.",
    },
    "ifeval": {
        "system": "Curate instruction-following examples with verifiable constraints. Return JSON only.",
        "generate_prompt": "Generate exactly one Google IFEval-style example with one to three verifiable constraints: exact word count, format, capitalization, no punctuation, a specified language, included/excluded keywords or JSON output. Vary constraints across examples. The final answer must satisfy every constraint exactly; reasoning can be empty. Example constraints: exactly 50 words without the letter e; JSON with name/age/city and uppercase values; a four-line poem with each line beginning with the same letter. Return only JSON fields question, reasoning and final_answer.",
    },
}


JUDGE_PROMPT = 'Evaluate a few-shot reasoning example for source {source}.\nReturn only JSON (no Markdown):\n{{"format": <1-5>, "cot_validity": <1-5>, "answer_alignment": <1-5>, "hallucination_inverse": <1-5>, "sufficiency": <1-5>, "verdict": "pass" | "fail", "rationale": "<at most 200 characters>"}}\nFive is excellent. Grade format compliance, logical and error-free reasoning, agreement between final answer and reasoning, absence of hallucinations (5=none, 1=many), and usefulness as a task example. Pass only if every score is at least four.\nEXAMPLE:\n{ex}\nJSON:'

AXES = ["format", "cot_validity", "answer_alignment", "hallucination_inverse", "sufficiency"]


def parse_json_object(text: str) -> dict | None:
    text = text.strip()
    if text.startswith("```"):
        lines = text.splitlines()
        if lines[0].startswith("```"):
            lines = lines[1:]
        if lines and lines[-1].startswith("```"):
            lines = lines[:-1]
        text = "\n".join(lines).strip()
    s = text.find("{")
    e = text.rfind("}")
    if s == -1 or e == -1:
        return None
    try:
        return json.loads(text[s : e + 1])
    except json.JSONDecodeError:
        return None


def main():
    import os

    out_dir = data_dir("fewshot_pools")
    client = RegoloClient()
    judge = Judge(n_judges=2)  # 2 judges (T0.2 + T0.5) for cost

    only = os.environ.get("REGEN_ONLY", "").split(",") if os.environ.get("REGEN_ONLY") else None
    SPECS = {k: v for k, v in SPECS_FULL.items() if not only or k in only}

    summary: dict = {}

    for sid, spec in SPECS.items():
        out_path = out_dir / f"{sid}.json"
        print(f"\n=== {sid} ===")

        candidates: list[dict] = []
        attempts = 0
        while len(candidates) < N_CANDIDATES and attempts < N_CANDIDATES * 2:
            attempts += 1
            try:
                out = client.text(
                    spec["generate_prompt"],
                    system=spec["system"],
                    temperature=0.7,
                    max_tokens=2048,
                )
                obj = parse_json_object(out)
                if not obj or "question" not in obj or "final_answer" not in obj:
                    continue
                obj.setdefault("reasoning", "")
                obj.setdefault("options_formatted", None)
                # Avoid duplicates
                if any(c["question"][:80] == obj["question"][:80] for c in candidates):
                    continue
                candidates.append(obj)
                print(f"  [gen {len(candidates)}/{N_CANDIDATES}] {obj['question'][:80]!r}")
            except Exception as e:
                print(f"  [warn] gen attempt {attempts} failed: {type(e).__name__}: {str(e)[:120]}")

        # Judge each candidate
        scored = []
        for i, c in enumerate(candidates):
            ex_text = json.dumps(c, ensure_ascii=False, indent=2)
            prompt = JUDGE_PROMPT.format(source=sid, ex=ex_text)
            try:
                result = judge.score(prompt, axes=AXES, max_tokens=512)
                avg = sum(result["scores"].values()) / len(result["scores"]) if result["scores"] else 0
            except Exception as e:
                avg = 0
                result = {"verdict": "error", "scores": {}, "rationales": str(e)[:120]}
            scored.append((avg, c, result))
            print(f"  [judge {i + 1}/{len(candidates)}] avg={avg:.2f} v={result.get('verdict')}")

        # Top K_KEEP by avg
        scored.sort(key=lambda x: -x[0])
        kept = scored[:K_KEEP]
        kept_avg = sum(s[0] for s in kept) / len(kept) if kept else 0
        print(f"  → kept top {len(kept)}, kept avg score = {kept_avg:.2f}")

        if len(kept) < K_KEEP or kept_avg < MIN_SCORE:
            print(f"  [warn] {sid}: kept_avg {kept_avg:.2f} < {MIN_SCORE}, saving best-effort")

        examples = [c for _, c, _ in kept]
        out_path.write_text(json.dumps(examples, ensure_ascii=False, indent=2), encoding="utf-8")
        sha = file_sha256(out_path)
        print(f"  saved → {out_path}")
        print(f"  SHA256: {sha}")

        summary[sid] = {
            "n_candidates": len(candidates),
            "n_kept": len(kept),
            "kept_avg_score": round(kept_avg, 3),
            "scores_per_kept": [round(s, 3) for s, _, _ in kept],
            "sha256": sha,
            "regenerated_at": utc_now_iso(),
        }

    # Update lockfile
    import yaml

    lockfile = data_dir("reports") / "lockfile.yaml"
    entries = {}
    if lockfile.exists():
        with open(lockfile) as f:
            entries = yaml.safe_load(f) or {}
    for sid, info in summary.items():
        entries[f"fewshot_synthetic_{sid}"] = {
            "model": "qwen3.5-122b@regolo (rev.4 with judge)",
            "n": info["n_kept"],
            "sha256": info["sha256"],
            "kept_avg_score": info["kept_avg_score"],
            "regenerated_at": info["regenerated_at"],
        }
    with open(lockfile, "w") as f:
        yaml.safe_dump(entries, f, default_flow_style=False, sort_keys=True)

    print("\n[30c] summary:")
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
