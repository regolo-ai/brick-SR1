"""Heuristic-based annotator for the 200-query sample.

Scoring rules for each capability (0.0 / 0.3 / 0.5 / 0.7 / 1.0):
- instruction_following: explicit format/structural constraints
- coding: writing/debugging/explaining code
- math_reasoning: numerical/logical multi-step problem solving
- world_knowledge: factual recall about real world
- planning_agentic: multi-step plans, decomposition, orchestration
- creative_synthesis: original creative output (story, poem, design)

This emulates my (Claude) judgment as a careful annotator. Reproducible.
"""

from __future__ import annotations

import csv
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
INPUT = ROOT / "data" / "human_eval" / "sample_200.csv"
OUTPUT = ROOT / "data" / "human_eval" / "sample_200_filled.csv"
DIMS = [
    "instruction_following",
    "coding",
    "math_reasoning",
    "world_knowledge",
    "planning_agentic",
    "creative_synthesis",
]


def score_query(q: str, split_type: str) -> dict[str, float]:
    """Return 6-dim score dict in [0.0, 1.0] using keyword + structural heuristics."""
    s = {d: 0.0 for d in DIMS}
    ql = q.lower()
    L = len(q)

    # ---- INSTRUCTION FOLLOWING ----
    if_score = 0.0
    if_kw_strong = [
        "respond only",
        "output only",
        "json",
        "schema",
        "exactly",
        "must include",
        "must be",
        "format:",
        "constraint",
        "do not include",
        "must not",
        "markdown table",
        "numbered list",
        "bullet",
        "rubric",
    ]
    if_kw_med = [
        "follow",
        "rules",
        "structure",
        "section",
        "headers",
        "step",
        "in the following format",
        "specific format",
        "n words",
        "characters",
        "limit",
        "respond in",
    ]
    if_strong = sum(1 for k in if_kw_strong if k in ql)
    if_med = sum(1 for k in if_kw_med if k in ql)
    word_count_constraint = bool(
        re.search(
            r"\b(exactly|at most|no more than|at least)\s+\d+\s+(word|sentence|paragraph|line|character|haiku|verse|act|step)",
            ql,
        )
    )
    multi_constraints = ql.count("must ") + ql.count("require") + ql.count("constraint")
    if word_count_constraint or if_strong >= 2:
        if_score = 1.0
    elif if_strong == 1 or multi_constraints >= 2:
        if_score = 0.7
    elif if_med >= 2 or multi_constraints == 1:
        if_score = 0.5
    elif if_med == 1:
        if_score = 0.3
    s["instruction_following"] = if_score

    # ---- CODING ----
    code_score = 0.0
    code_kw_strong = [
        "python",
        "javascript",
        "java ",
        "c++",
        "rust ",
        "go ",
        "code",
        "function",
        " class ",
        "method",
        "algorithm",
        "implement",
        "debug",
        " api ",
        "library",
        "endpoint",
        "regex",
        "sql ",
        "bash",
        "shell script",
        "unit test",
        "package",
        "module",
        "compile",
        "syntax",
        "git ",
        "docker",
        "kubernetes",
        "framework",
        "react",
        "django",
        "flask",
        "node",
        "fastapi",
        "javascript",
    ]
    code_kw_weak = ["script", "automate", "automation", "build a tool", "write a program", "computational"]
    code_strong = sum(1 for k in code_kw_strong if k in ql)
    code_weak = sum(1 for k in code_kw_weak if k in ql)
    if code_strong >= 2 or "write a python" in ql or "implement" in ql and "function" in ql:
        code_score = 1.0
    elif code_strong == 1:
        code_score = 0.7
    elif code_weak >= 1:
        code_score = 0.5
    s["coding"] = code_score

    # ---- MATH REASONING ----
    math_score = 0.0
    math_kw_strong = [
        "calculate",
        "solve",
        "equation",
        "probability",
        "derivative",
        "integral",
        "matrix",
        "vector",
        "logarithm",
        "polynomial",
        "theorem",
        "proof",
        "geometric",
        "algebraic",
        "trigonomet",
        "differential",
        "factorial",
    ]
    math_kw_weak = [
        "how many",
        "what is the",
        "average",
        "sum",
        "ratio",
        "percent",
        "fraction",
        "number of",
        "count",
        "estimate",
        "compute",
        "duration",
    ]
    has_math_kw_strong = sum(1 for k in math_kw_strong if k in ql)
    has_math_kw_weak = sum(1 for k in math_kw_weak if k in ql)
    has_numbers = bool(re.search(r"\b\d{2,}\b", q)) or "x" in ql and "=" in ql
    word_problem = bool(re.search(r"\b(if|given|suppose)\b.*\b(how many|how much|what is)\b", ql, re.DOTALL))
    if has_math_kw_strong >= 1 or word_problem:
        math_score = 1.0
    elif has_math_kw_weak >= 2 and has_numbers:
        math_score = 0.7
    elif has_math_kw_weak >= 1 and has_numbers:
        math_score = 0.5
    elif has_math_kw_weak >= 1:
        math_score = 0.3
    s["math_reasoning"] = math_score

    # ---- WORLD KNOWLEDGE ----
    wk_score = 0.0
    wk_kw_strong = [
        "history",
        "historical",
        "scientific",
        "biology",
        "chemistry",
        "physics",
        "geography",
        "ancient",
        "century",
        "war",
        "empire",
        "revolution",
        "scientist",
        "philosopher",
        "discover",
        "invented",
        "treaty",
        "constitution",
        "newton",
        "einstein",
        "darwin",
        "shakespeare",
        "napoleon",
        "lincoln",
        "celsius",
        "kelvin",
        "the year",
        "civilization",
        "religion",
    ]
    wk_kw_weak = [
        "what is",
        "explain",
        "describe",
        "what are",
        "tell me about",
        "who was",
        "background",
        "context",
        "famous",
        "known for",
    ]
    wk_strong = sum(1 for k in wk_kw_strong if k in ql)
    wk_weak = sum(1 for k in wk_kw_weak if k in ql)
    proper_nouns = len(re.findall(r"\b[A-Z][a-z]{3,}\s+[A-Z][a-z]+", q))
    if wk_strong >= 2 or proper_nouns >= 2:
        wk_score = 1.0
    elif wk_strong == 1:
        wk_score = 0.7
    elif wk_weak >= 1 and proper_nouns >= 1:
        wk_score = 0.5
    elif wk_weak >= 1:
        wk_score = 0.3
    s["world_knowledge"] = wk_score

    # ---- PLANNING AGENTIC ----
    pa_score = 0.0
    pa_kw_strong = [
        "multi-step",
        "multi step",
        "step-by-step",
        "phase 1",
        "phase 2",
        "first,",
        "then,",
        "decompose",
        "orchestrat",
        "agent",
        "workflow",
        "pipeline",
        "automat",
        "schedule",
        "monitor",
        "iterat",
        "loop",
    ]
    pa_kw_med = [
        "plan",
        "design a system",
        "build a",
        "architect",
        "process",
        "stages",
        "sequence",
        "coordinate",
        "manage",
        "integrate",
        "tool use",
    ]
    pa_strong = sum(1 for k in pa_kw_strong if k in ql)
    pa_med = sum(1 for k in pa_kw_med if k in ql)
    has_numbered_steps = bool(re.search(r"\b1[\.\)]\s+\w+.*\b2[\.\)]\s+", q, re.DOTALL))
    if pa_strong >= 2 or has_numbered_steps:
        pa_score = 1.0
    elif pa_strong == 1:
        pa_score = 0.7
    elif pa_med >= 2:
        pa_score = 0.5
    elif pa_med == 1:
        pa_score = 0.3
    s["planning_agentic"] = pa_score

    # ---- CREATIVE SYNTHESIS ----
    cs_score = 0.0
    cs_kw_strong = [
        "write a story",
        "haiku",
        "poem",
        "novel",
        "short story",
        "marketing copy",
        "marketing email",
        "marketing campaign",
        "creative writing",
        "screenplay",
        "dialogue",
        "monologue",
        "narrative",
        "fictional",
        "imagine",
        "compose a",
        "write a song",
        "lyrics",
        "advertisement",
        "tagline",
        "slogan",
        "fairy tale",
    ]
    cs_kw_med = ["original", "creative", "design a", "describe a", "invent", "brainstorm", "idea", "scenario"]
    cs_strong = sum(1 for k in cs_kw_strong if k in ql)
    cs_med = sum(1 for k in cs_kw_med if k in ql)
    if cs_strong >= 1:
        cs_score = 1.0
    elif cs_med >= 2:
        cs_score = 0.5
    elif cs_med == 1:
        cs_score = 0.3
    s["creative_synthesis"] = cs_score

    # Edge case adjustments
    if split_type == "edge_case" and L < 20:
        # very short queries: drop most scores
        for d in DIMS:
            s[d] = min(s[d], 0.3)

    # Ensure scores in valid range
    for d in DIMS:
        s[d] = round(max(0.0, min(1.0, s[d])), 1)
    return s


def main() -> None:
    rows_in = []
    with INPUT.open() as f:
        rdr = csv.DictReader(f)
        for r in rdr:
            rows_in.append(r)

    with OUTPUT.open("w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["query_id", "split_type", "query"] + DIMS + ["notes"])
        for r in rows_in:
            scores = score_query(r["query"], r["split_type"])
            w.writerow([r["query_id"], r["split_type"], r["query"]] + [scores[d] for d in DIMS] + [""])
    print(f"wrote {len(rows_in)} annotated rows to {OUTPUT}")


if __name__ == "__main__":
    main()
