#!/usr/bin/env python3
"""Build the brick_large benchmark dataset: 2000 questions, 400 per category.

Purest MMLU-Pro extraction: all original options kept (A-J, up to 10 choices),
same 5 categories as brick_hard, no hand-written additions, no GPQA (gated).

Categories → MMLU-Pro sources:
  coding          → computer_science  (~410 available)
  math_reasoning  → math              (~1351 available)
  humanities      → law + philosophy  (~2033 available)
  science_knowledge → biology + chemistry + physics + health (~3026 available)
  general         → economics + psychology                   (~1642 available)

Usage:
    cd evals/
    python build_brick_large_dataset.py [--seed 2000] [--no-dedup]

Output:
    custom_tasks/brick_large/test.jsonl  (2000 questions)
"""

import argparse
import json
import random
from collections import Counter
from pathlib import Path

import datasets as hf_datasets


EVALS_DIR = Path(__file__).parent
OUTPUT = EVALS_DIR / "custom_tasks/brick_large/test.jsonl"

# Questions already used in brick_hard and brick_general — exclude to keep tests independent
EXISTING_TESTS = [
    EVALS_DIR / "custom_tasks/brick_hard/test.jsonl",
    EVALS_DIR / "custom_tasks/brick_general/test.jsonl",
    EVALS_DIR / "custom_tasks/brick_mixed/test.jsonl",
]

N_PER_CATEGORY = 400
CATEGORIES = ["coding", "math_reasoning", "humanities", "science_knowledge", "general"]


def load_existing_questions() -> set[str]:
    """Load question texts from existing tests to avoid overlap."""
    seen = set()
    for path in EXISTING_TESTS:
        if path.exists():
            for line in path.open():
                row = json.loads(line)
                seen.add(row["question"].strip())
    print(f"  Loaded {len(seen)} existing questions to exclude.")
    return seen


def sample_mmlu_pro_full(
    categories: list[str], n: int, seed: int, exclude: set[str]
) -> list[dict]:
    """Sample n questions from MMLU-Pro test split, keeping ALL original options (A-J).

    Filters out empty option strings; re-assigns answer letter based on position
    in the filtered list.  Excludes questions already in existing benchmarks.
    """
    rng = random.Random(seed)
    ds = hf_datasets.load_dataset("TIGER-Lab/MMLU-Pro", split="test")
    pool = [
        row for row in ds
        if row["category"] in categories and row["question"].strip() not in exclude
    ]
    if len(pool) < n:
        print(f"  [WARN] Only {len(pool)} available (need {n}) for {categories}. Taking all.")
    sampled = rng.sample(pool, min(n, len(pool)))

    results = []
    for row in sampled:
        # Keep all non-empty options
        options = [o for o in row["options"] if isinstance(o, str) and o.strip()]
        if not options:
            continue

        answer_idx = row["answer_index"]
        correct = row["options"][answer_idx]

        # Remap answer letter after filtering blanks
        try:
            new_idx = options.index(correct)
        except ValueError:
            # Correct answer was in a blank slot — skip this question
            continue

        answer_letter = "ABCDEFGHIJ"[new_idx]

        results.append({
            "question": row["question"],
            "choices": options,
            "answer": answer_letter,
            "source": f"mmlu_pro_{row['category'].replace(' ', '_')}",
        })
    return results


def build(seed: int, exclude: set[str]) -> list[dict]:
    questions = []

    print("  [1/5] coding — MMLU-Pro computer_science (+ engineering fallback)...")
    coding_qs = sample_mmlu_pro_full(["computer science"], N_PER_CATEGORY, seed, exclude)
    if len(coding_qs) < N_PER_CATEGORY:
        shortfall = N_PER_CATEGORY - len(coding_qs)
        print(f"  [INFO] CS gave {len(coding_qs)}, pulling {shortfall} from engineering...")
        used_q = {q["question"] for q in coding_qs}
        extra_exclude = exclude | used_q
        eng_qs = sample_mmlu_pro_full(["engineering"], shortfall, seed + 100, extra_exclude)
        coding_qs.extend(eng_qs)
    for q in coding_qs:
        q["category"] = "coding"
        questions.append(q)

    print("  [2/5] math_reasoning — MMLU-Pro math...")
    for q in sample_mmlu_pro_full(["math"], N_PER_CATEGORY, seed + 1, exclude):
        q["category"] = "math_reasoning"
        questions.append(q)

    print("  [3/5] humanities — MMLU-Pro law + philosophy...")
    for q in sample_mmlu_pro_full(["law", "philosophy"], N_PER_CATEGORY, seed + 2, exclude):
        q["category"] = "humanities"
        questions.append(q)

    print("  [4/5] science_knowledge — MMLU-Pro biology + chemistry + physics + health...")
    for q in sample_mmlu_pro_full(
        ["biology", "chemistry", "physics", "health"], N_PER_CATEGORY, seed + 3, exclude
    ):
        q["category"] = "science_knowledge"
        questions.append(q)

    print("  [5/5] general — MMLU-Pro economics + psychology...")
    for q in sample_mmlu_pro_full(["economics", "psychology"], N_PER_CATEGORY, seed + 4, exclude):
        q["category"] = "general"
        questions.append(q)

    return questions


def assign_ids(questions: list[dict]) -> list[dict]:
    counters: dict[str, int] = {}
    for q in questions:
        cat = q["category"]
        counters[cat] = counters.get(cat, 0) + 1
        q["id"] = f"{cat}_{counters[cat]:04d}"
        q.setdefault("router_notes", "")
    return questions


def validate(questions: list[dict]) -> None:
    total = len(questions)
    assert total == 2000, f"Expected 2000 questions, got {total}"

    cats = Counter(q["category"] for q in questions)
    for cat in CATEGORIES:
        count = cats.get(cat, 0)
        assert 350 <= count <= 400, f"{cat}: {count} (expected ~400)"

    ids = [q["id"] for q in questions]
    assert len(ids) == len(set(ids)), "Duplicate IDs found"

    letters = set("ABCDEFGHIJ")
    for q in questions:
        assert q["answer"] in letters, f"Bad answer letter: {q['answer']} in {q['id']}"
        assert 2 <= len(q["choices"]) <= 10, f"Unexpected choices count in {q['id']}"
        assert all(isinstance(c, str) and c.strip() for c in q["choices"])

    print(f"Validation passed — {total} questions.")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--seed", type=int, default=2000,
                        help="Random seed (default 2000, different from existing tests)")
    parser.add_argument("--no-dedup", action="store_true",
                        help="Skip excluding questions already in brick_hard/general/mixed")
    args = parser.parse_args()

    print(f"Building brick_large dataset (seed={args.seed}, N={N_PER_CATEGORY}/category)...")

    if args.no_dedup:
        exclude: set[str] = set()
    else:
        exclude = load_existing_questions()

    print("Sampling from HuggingFace MMLU-Pro...")
    questions = build(args.seed, exclude)
    print(f"  Sampled: {len(questions)} questions")

    questions = assign_ids(questions)

    cats = Counter(q["category"] for q in questions)
    print(f"\nCategory breakdown ({len(questions)} total):")
    for cat in CATEGORIES:
        print(f"  {cat}: {cats.get(cat, 0)}")

    validate(questions)

    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    with open(OUTPUT, "w") as f:
        for q in questions:
            f.write(json.dumps(q, ensure_ascii=False) + "\n")
    print(f"\nWritten to {OUTPUT}")
    print(f"Total: {len(questions)} questions across {len(cats)} categories.")


if __name__ == "__main__":
    main()
