#!/usr/bin/env python3
"""Build the brick_general mixed benchmark dataset.

Samples ~30 MC questions per category from existing HuggingFace datasets,
normalizes them to A/B/C/D format, and merges with hand-written edge cases.

Usage:
    cd evals/
    python build_brick_general_dataset.py [--seed 42] [--no-handwritten]

Output:
    custom_tasks/brick_general/test.jsonl  (200 questions)
"""

import argparse
import json
import random
from collections import Counter
from pathlib import Path

import datasets as hf_datasets


EVALS_DIR = Path(__file__).parent
OUTPUT = EVALS_DIR / "custom_tasks/brick_general/test.jsonl"
HAND_WRITTEN = EVALS_DIR / "custom_tasks/brick_general/hand_written_questions.jsonl"


def sample_mmlu_pro(categories: list[str], n: int, seed: int) -> list[dict]:
    """Sample n questions from MMLU-Pro test split, filtered to given categories.

    MMLU-Pro has up to 10 options (A-J). We keep the correct answer + 3 random
    distractors, re-shuffle, then recompute the answer letter.
    """
    rng = random.Random(seed)
    ds = hf_datasets.load_dataset("TIGER-Lab/MMLU-Pro", split="test")
    pool = [row for row in ds if row["category"] in categories]
    sampled = rng.sample(pool, min(n, len(pool)))

    results = []
    for row in sampled:
        options = row["options"]
        answer_idx = row["answer_index"]
        correct = options[answer_idx]

        distractors = [o for i, o in enumerate(options) if i != answer_idx and o.strip()]
        chosen = rng.sample(distractors, min(3, len(distractors)))

        four = [correct] + chosen
        rng.shuffle(four)
        new_idx = four.index(correct)

        results.append({
            "question": row["question"],
            "choices": four,
            "answer": "ABCD"[new_idx],
            "source": f"mmlu_pro_{row['category'].replace(' ', '_')}",
        })
    return results


def sample_arc_challenge(n: int, seed: int) -> list[dict]:
    """Sample n questions from ARC-Challenge test split (4-choice only)."""
    rng = random.Random(seed)
    ds = hf_datasets.load_dataset("allenai/ai2_arc", "ARC-Challenge", split="test")
    pool = [row for row in ds if len(row["choices"]["text"]) == 4]
    sampled = rng.sample(pool, min(n, len(pool)))

    results = []
    for row in sampled:
        answer_key = row["answerKey"]
        if answer_key in "1234":
            answer_key = "ABCD"[int(answer_key) - 1]
        results.append({
            "question": row["question"],
            "choices": row["choices"]["text"],
            "answer": answer_key,
            "source": "arc_challenge",
        })
    return results


def build_sampled(seed: int) -> list[dict]:
    questions = []

    # coding (30) — MMLU-Pro computer_science
    for q in sample_mmlu_pro(["computer science"], 30, seed):
        q["category"] = "coding"
        questions.append(q)

    # math_reasoning (30) — MMLU-Pro math + engineering
    for q in sample_mmlu_pro(["math", "engineering"], 30, seed + 1):
        q["category"] = "math_reasoning"
        questions.append(q)

    # humanities (30) — MMLU-Pro history + philosophy + law
    for q in sample_mmlu_pro(["history", "philosophy", "law"], 30, seed + 2):
        q["category"] = "humanities"
        questions.append(q)

    # science_knowledge (30) — MMLU-Pro bio/chem/physics/health (20) + ARC (10)
    for q in sample_mmlu_pro(["biology", "chemistry", "physics", "health"], 20, seed + 3):
        q["category"] = "science_knowledge"
        questions.append(q)
    for q in sample_arc_challenge(10, seed + 3):
        q["category"] = "science_knowledge"
        questions.append(q)

    # general (30) — MMLU-Pro other/business/econ/psych (20) + ARC (10)
    for q in sample_mmlu_pro(["other", "business", "economics", "psychology"], 20, seed + 4):
        q["category"] = "general"
        questions.append(q)
    for q in sample_arc_challenge(10, seed + 5):
        q["category"] = "general"
        questions.append(q)

    return questions


def balance_answers(questions: list[dict]) -> list[dict]:
    """Rebalance answer distribution to ~25% per letter within each category.

    For questions where the answer letter is over-represented, rotate the
    choices cyclically so the correct answer moves to an under-represented
    letter.  This preserves question content and correctness.
    """
    categories = sorted(set(q["category"] for q in questions))
    for cat in categories:
        cat_qs = [q for q in questions if q["category"] == cat]
        target_per_letter = len(cat_qs) // 4  # 10 per letter for 40 questions

        for _ in range(10):  # iterative rebalancing passes
            counts = Counter(q["answer"] for q in cat_qs)
            over = [l for l in "ABCD" if counts.get(l, 0) > target_per_letter + 1]
            under = [l for l in "ABCD" if counts.get(l, 0) < target_per_letter]
            if not over or not under:
                break
            for q in cat_qs:
                if q["answer"] not in over:
                    continue
                if not under:
                    break
                # Rotate choices so correct answer lands on an under-represented letter
                old_idx = "ABCD".index(q["answer"])
                new_letter = under[0]
                new_idx = "ABCD".index(new_letter)
                shift = (new_idx - old_idx) % 4
                q["choices"] = q["choices"][(-shift) % 4:] + q["choices"][:(-shift) % 4]
                q["answer"] = new_letter
                counts[over[0]] = counts.get(over[0], 0) - 1
                counts[new_letter] = counts.get(new_letter, 0) + 1
                over = [l for l in "ABCD" if counts.get(l, 0) > target_per_letter + 1]
                under = [l for l in "ABCD" if counts.get(l, 0) < target_per_letter]
                if not under:
                    break
    return questions


def assign_ids(questions: list[dict]) -> list[dict]:
    counters: dict[str, int] = {}
    for q in questions:
        cat = q["category"]
        counters[cat] = counters.get(cat, 0) + 1
        q["id"] = f"{cat}_{counters[cat]:03d}"
        q.setdefault("router_notes", "")
    return questions


def validate(questions: list[dict]) -> None:
    assert len(questions) == 200, f"Expected 200, got {len(questions)}"
    categories = {"coding", "math_reasoning", "humanities", "science_knowledge", "general"}
    cats = Counter(q["category"] for q in questions)
    for cat in categories:
        assert 35 <= cats[cat] <= 45, f"{cat}: {cats[cat]} (expected ~40)"
    ids = [q["id"] for q in questions]
    assert len(ids) == len(set(ids)), "Duplicate IDs found"
    for q in questions:
        assert q["answer"] in "ABCD", f"Bad answer: {q['answer']}"
        assert len(q["choices"]) == 4, f"Not 4 choices: {q['id']}"
        assert all(isinstance(c, str) and c.strip() for c in q["choices"])
    print("Validation passed.")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--no-handwritten", action="store_true",
                        help="Skip merging hand_written_questions.jsonl")
    args = parser.parse_args()

    print("Sampling from HuggingFace datasets...")
    questions = build_sampled(args.seed)
    print(f"  Sampled: {len(questions)} questions")

    if not args.no_handwritten and HAND_WRITTEN.exists():
        hw = [json.loads(line) for line in HAND_WRITTEN.open()]
        print(f"  Hand-written: {len(hw)} questions")
        questions.extend(hw)
    elif not args.no_handwritten:
        print(f"  [WARN] {HAND_WRITTEN} not found — skipping hand-written questions")
        print("         Run with --no-handwritten to suppress this warning.")

    questions = balance_answers(questions)
    questions = assign_ids(questions)

    cats = Counter(q["category"] for q in questions)
    print(f"\nCategory breakdown ({len(questions)} total):")
    for cat in sorted(cats):
        print(f"  {cat}: {cats[cat]}")

    validate(questions)

    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    with open(OUTPUT, "w") as f:
        for q in questions:
            f.write(json.dumps(q, ensure_ascii=False) + "\n")
    print(f"\nWritten to {OUTPUT}")


if __name__ == "__main__":
    main()
