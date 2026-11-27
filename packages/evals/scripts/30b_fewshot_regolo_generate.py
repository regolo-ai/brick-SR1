#!/usr/bin/env python3
"""Generate five reasoning examples for each source without a suitable few-shot pool. Store question, reasoning and final_answer in data/fewshot_pools/<source_id>.json and record SHA256 provenance."""

from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from brick_evals.io_utils import data_dir, file_sha256, utc_now_iso
from brick_evals.regolo_client import RegoloClient

K = 5

# Uniform target schema
META_PROMPT = "You curate few-shot reasoning examples for LLM benchmarks.\nGenerate EXACTLY five distinct examples for the specified source. Each JSON object has these fields:\n{spec}\nRequirements:\n- Vary topics, difficulty and structure.\n- Use realistic examples rather than artificial templates.\n- Match the source style.\n- Return ONLY a JSON array of five objects, without Markdown fences, comments or extra text.\nTarget source: {source}\nDescription: {description}\n{extra_constraints}\nJSON array:"


SOURCE_SPECS = {
    "math500": {
        "description": "MATH-500: competition mathematics across algebra, geometry, number theory, calculus, combinatorics, intermediate algebra, prealgebra and precalculus. Final answers typically use LaTeX boxed notation.",
        "spec": '{"question": "<problem in LaTeX>", "reasoning": "<step-by-step LaTeX solution with numerical calculations>", "final_answer": "<LaTeX answer such as \\\\boxed{42} or \\\\frac{3}{4}>"}',
        "extra": "Cover at least three distinct subject areas.",
    },
    "aime_2025": {
        "description": "AIME 2025 competition mathematics with integer answers from 0 to 999.",
        "spec": '{"question": "<problem text, roughly 100-300 characters>", "reasoning": "<step-by-step solution with explicit calculations>", "final_answer": "<integer 0-999 as a string>"}',
        "extra": "Use medium-to-hard problems. final_answer must contain only the integer string.",
    },
    "livecodebench_v6": {
        "description": "LiveCodeBench v6 mixed competitive programming: functional LeetCode problems and standard-input AtCoder/Codeforces problems. Cover both types.",
        "spec": '{"question": "<English problem with constraints, examples and explicit input/output specification. Functional questions end with class Solution starter code; stdin questions describe input lines without starter code.>", "reasoning": "<Identify the algorithm: hash map, variable-size sliding window, two pointers, DP, greedy or mathematics.>", "final_answer": "<Executable Python: camelCase method inside class Solution for functional problems, or a top-level input/print script for stdin problems.>"}',
        "extra": "Exactly three functional examples using hash maps, a variable-size window with a shrinking while loop, and top-down DP; exactly two stdin examples using greedy/sorting and mathematics/number theory. Functional questions end with class Solution and a typed method signature. Stdin questions state the Standard Input format and have no class Solution. Explicitly name the technique in reasoning. Avoid verbose code comments and lengthy reasoning. Example stdin structure (do not copy): read N, read A_1 ... A_N, then print the answer.",
    },
    "ifbench": {
        "description": "IFBench instruction following with one or two explicit, verifiable constraints.",
        "spec": '{"question": "<Complete instruction with explicit constraints, such as a unique-word count, sentence/word ratio or palindrome count>", "reasoning": "", "final_answer": "<Actual complete response satisfying every constraint, never a placeholder>"}',
        "extra": "Five diverse examples: unique words, sentence/word ratio, palindromes, repeated words and formatting such as all caps with a word count. Verify each answer against all constraints. Keep reasoning empty and instructions realistic. Generate sufficient text for long constraints such as at least 128 unique words.",
    },
    "ifeval": {
        "description": "Google IFEval instruction following with clear verifiable constraints on word count, format, language or keywords.",
        "spec": '{"question": "<Instruction with one to three explicit constraints>", "reasoning": "", "final_answer": "<Response satisfying all constraints exactly>"}',
        "extra": "Use five distinct constraint types such as word count, all caps, JSON format, no commas or a specified language. Reasoning can be empty.",
    },
    "gpqa_diamond": {
        "description": "Graduate-level physics, chemistry and biology multiple choice with four options and one correct answer.",
        "spec": '{"question": "<Graduate-level question>", "options_formatted": "A. <option1>\\nB. <option2>\\nC. <option3>\\nD. <option4>", "reasoning": "<Step-by-step scientific explanation>", "final_answer": "<One letter A/B/C/D>"}',
        "extra": "Mix physics, chemistry and biology. Use plausible distractors and exactly one answer letter.",
    },
    "eqbench_creative_v3": {
        "description": "EQ-Bench Creative Writing v3: stylistically constrained prompts with short story or scene responses of 200-1000 characters.",
        "spec": '{"question": "<Creative prompt with a stylistic constraint>", "reasoning": "", "final_answer": "<Creative response of 200-1000 characters satisfying the prompt>"}',
        "extra": "Vary the five prompts across literary, science fiction, horror, comedy and dialogue-driven writing. final_answer contains the creative text.",
    },
}


def _parse_json_array(text: str) -> list[dict]:
    """Extract a JSON array from model output, tolerating code fences."""
    text = text.strip()
    if text.startswith("```"):
        # Remove surrounding code fences.
        lines = text.splitlines()
        if lines[0].startswith("```"):
            lines = lines[1:]
        if lines and lines[-1].startswith("```"):
            lines = lines[:-1]
        text = "\n".join(lines).strip()
    # Trova primo '[' e ultimo ']'
    start = text.find("[")
    end = text.rfind("]")
    if start == -1 or end == -1 or end <= start:
        raise ValueError(f"no JSON array found in output: {text[:200]}")
    arr_text = text[start : end + 1]
    # strict=False: allow literal control chars in strings (code blocks with newlines)
    return json.loads(arr_text, strict=False)


def generate_for_source(client: RegoloClient, source_id: str, spec: dict) -> list[dict]:
    prompt = META_PROMPT.format(
        source=source_id,
        description=spec["description"],
        spec=spec["spec"],
        extra_constraints=spec.get("extra", ""),
    )
    out = client.text(
        prompt,
        system="Sei un curatore di esempi few-shot per benchmark LLM. Output: solo JSON array, no commentary.",
        temperature=0.7,
        max_tokens=4096,
    )
    arr = _parse_json_array(out)
    if not isinstance(arr, list) or len(arr) < 1:
        raise ValueError(f"expected list, got {type(arr).__name__}")
    return arr[:K]


def main():
    out_dir = data_dir("fewshot_pools")
    client = RegoloClient()

    results: dict[str, dict] = {}
    for sid, spec in SOURCE_SPECS.items():
        out_path = out_dir / f"{sid}.json"
        # Skip an existing nonempty output.
        if out_path.exists():
            try:
                existing = json.loads(out_path.read_text())
                if isinstance(existing, list) and len(existing) >= K and any(e.get("question") for e in existing):
                    print(f"  [SKIP] {sid}: already populated ({len(existing)} examples)")
                    continue
            except Exception:
                pass

        print(f"\n=== {sid} ===")
        last_err = None
        for attempt in range(3):
            try:
                examples = generate_for_source(client, sid, spec)
                # Validate min schema: question + final_answer present
                bad = [i for i, e in enumerate(examples) if not e.get("question") or "final_answer" not in e]
                if bad:
                    raise ValueError(f"missing fields in examples {bad}")
                break
            except Exception as e:
                last_err = e
                print(f"  [warn] attempt {attempt + 1} failed: {type(e).__name__}: {str(e)[:120]}")
                examples = None
        if not examples:
            print(f"  [FAIL] {sid}: {last_err}")
            continue

        # Ensure list-typed fields
        for e in examples:
            if "reasoning" not in e:
                e["reasoning"] = ""
            if "options_formatted" not in e:
                e["options_formatted"] = None

        out_path.write_text(json.dumps(examples, ensure_ascii=False, indent=2), encoding="utf-8")
        sha = file_sha256(out_path)
        print(f"  saved {len(examples)} examples -> {out_path}")
        print(f"  SHA256: {sha}")
        results[sid] = {"n": len(examples), "sha256": sha}

    # Lockfile
    import yaml

    lockfile = data_dir("reports") / "lockfile.yaml"
    entries = {}
    if lockfile.exists():
        with open(lockfile) as f:
            entries = yaml.safe_load(f) or {}
    for sid, info in results.items():
        entries[f"fewshot_synthetic_{sid}"] = {
            "model": "qwen3.5-122b@regolo",
            "n": info["n"],
            "sha256": info["sha256"],
            "generated_at": utc_now_iso(),
        }
    with open(lockfile, "w") as f:
        yaml.safe_dump(entries, f, default_flow_style=False, sort_keys=True)


if __name__ == "__main__":
    main()
