#!/usr/bin/env python3
"""Build the brick_mixed benchmark dataset.

Reads from existing brick_general and brick_hard test.jsonl files (no HuggingFace
downloads required). Samples 20 easy + 20 hard questions per category for a total
of 200 questions that demonstrate cost-vs-accuracy trade-offs in semantic routing.

Usage:
    cd evals/
    python build_brick_mixed_dataset.py [--seed 42]

Output:
    custom_tasks/brick_mixed/test.jsonl  (200 questions)
"""

import argparse
import json
import random
from collections import Counter
from pathlib import Path


EVALS_DIR = Path(__file__).parent
GENERAL_JSONL = EVALS_DIR / "custom_tasks/brick_general/test.jsonl"
HARD_JSONL = EVALS_DIR / "custom_tasks/brick_hard/test.jsonl"
OUTPUT = EVALS_DIR / "custom_tasks/brick_mixed/test.jsonl"

# 5 categories present in both source datasets
CATEGORIES = ["coding", "math_reasoning", "humanities", "science_knowledge", "general"]
EASY_PER_CAT = 20
HARD_PER_CAT = 20


def load_jsonl(path: Path) -> list[dict]:
    with open(path) as f:
        return [json.loads(line) for line in f]


def remove_duplicates(general: list[dict], hard: list[dict]) -> list[dict]:
    """Remove questions from general that also appear in hard (match on first 100 chars)."""
    hard_keys = {q["question"][:100] for q in hard}
    before = len(general)
    filtered = [q for q in general if q["question"][:100] not in hard_keys]
    removed = before - len(filtered)
    if removed:
        print(f"  Removed {removed} duplicate question(s) from brick_general")
    return filtered


def sample_per_category(
    questions: list[dict],
    n_per_cat: int,
    rng: random.Random,
) -> list[dict]:
    """Sample n_per_cat questions from each category."""
    result = []
    for cat in CATEGORIES:
        pool = [q for q in questions if q["category"] == cat]
        if len(pool) < n_per_cat:
            raise ValueError(
                f"Not enough questions in category '{cat}': need {n_per_cat}, have {len(pool)}"
            )
        result.extend(rng.sample(pool, n_per_cat))
    return result


def enrich(questions: list[dict], difficulty: str, original_benchmark: str) -> list[dict]:
    """Add difficulty metadata fields."""
    enriched = []
    for q in questions:
        eq = dict(q)
        eq["difficulty"] = difficulty
        eq["num_choices"] = len(q["choices"])
        eq["original_benchmark"] = original_benchmark
        # Drop old id — will be reassigned
        eq.pop("id", None)
        eq.pop("router_notes", None)
        enriched.append(eq)
    return enriched


def assign_ids(questions: list[dict]) -> list[dict]:
    counters: dict[str, int] = {}
    for q in questions:
        cat = q["category"]
        counters[cat] = counters.get(cat, 0) + 1
        q["id"] = f"{cat}_{counters[cat]:03d}"
    return questions


def validate(questions: list[dict]) -> None:
    assert len(questions) == 200, f"Expected 200 questions, got {len(questions)}"
    cats = Counter(q["category"] for q in questions)
    for cat in CATEGORIES:
        assert cats[cat] == 40, f"{cat}: expected 40, got {cats[cat]}"
    for cat in CATEGORIES:
        cat_qs = [q for q in questions if q["category"] == cat]
        easy = [q for q in cat_qs if q["difficulty"] == "easy"]
        hard = [q for q in cat_qs if q["difficulty"] == "hard"]
        assert len(easy) == EASY_PER_CAT, f"{cat} easy: expected {EASY_PER_CAT}, got {len(easy)}"
        assert len(hard) == HARD_PER_CAT, f"{cat} hard: expected {HARD_PER_CAT}, got {len(hard)}"
    ids = [q["id"] for q in questions]
    assert len(ids) == len(set(ids)), "Duplicate IDs found"
    for q in questions:
        letters = "ABCDEFGHIJ"
        valid_answers = set(letters[: len(q["choices"])])
        assert q["answer"] in valid_answers, f"Bad answer '{q['answer']}' for {q['id']}"
        assert len(q["choices"]) in (4, 10), f"Unexpected choice count for {q['id']}"
    print("Validation passed.")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--seed", type=int, default=42)
    args = parser.parse_args()

    rng = random.Random(args.seed)

    print("Loading source datasets...")
    general_all = load_jsonl(GENERAL_JSONL)
    hard_all = load_jsonl(HARD_JSONL)
    print(f"  brick_general: {len(general_all)} questions")
    print(f"  brick_hard:    {len(hard_all)} questions")

    general_clean = remove_duplicates(general_all, hard_all)

    print(f"\nSampling {EASY_PER_CAT} easy + {HARD_PER_CAT} hard per category...")
    easy_sampled = sample_per_category(general_clean, EASY_PER_CAT, rng)
    hard_sampled = sample_per_category(hard_all, HARD_PER_CAT, rng)

    easy_enriched = enrich(easy_sampled, "easy", "brick_general")
    hard_enriched = enrich(hard_sampled, "hard", "brick_hard")

    # Interleave easy and hard per category, then shuffle deterministically
    combined: list[dict] = []
    for cat in CATEGORIES:
        cat_easy = [q for q in easy_enriched if q["category"] == cat]
        cat_hard = [q for q in hard_enriched if q["category"] == cat]
        cat_all = cat_easy + cat_hard
        rng.shuffle(cat_all)
        combined.extend(cat_all)

    # Global shuffle (easy/hard mixed across categories)
    rng.shuffle(combined)

    combined = assign_ids(combined)

    cats = Counter(q["category"] for q in combined)
    difficulties = Counter(q["difficulty"] for q in combined)
    print(f"\nDataset ({len(combined)} total):")
    print(f"  Difficulty: {dict(difficulties)}")
    for cat in sorted(cats):
        cat_qs = [q for q in combined if q["category"] == cat]
        easy = sum(1 for q in cat_qs if q["difficulty"] == "easy")
        hard = sum(1 for q in cat_qs if q["difficulty"] == "hard")
        print(f"  {cat}: {cats[cat]} ({easy} easy, {hard} hard)")

    validate(combined)

    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    with open(OUTPUT, "w") as f:
        for q in combined:
            f.write(json.dumps(q, ensure_ascii=False) + "\n")
    print(f"\nWritten to {OUTPUT}")


if __name__ == "__main__":
    main()
