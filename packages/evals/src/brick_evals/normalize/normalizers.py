"""Normalize functions per source: row nativo -> dict allineato a schema target.

Output: dict con keys query, expected_answer, language, difficulty_band, dataset_release_date,
contamination_risk, gated, license, source_meta (informazione raw extra non in schema).
"""

from __future__ import annotations

import json
import re


def _len_band(text: str) -> str:
    n = len(text or "")
    if n < 256:
        return "short"
    if n < 1024:
        return "med"
    return "long"


def normalize_ifeval(row: dict) -> dict:
    return {
        "query": row.get("prompt", ""),
        "expected_answer": {
            "type": "ifeval_constraint",
            "payload": {
                "instruction_id_list": row.get("instruction_id_list", []),
                "kwargs": row.get("kwargs", []),
                "key": row.get("key"),
            },
        },
        "language": "en",
        "difficulty_band": "med",  # IFEval no native difficulty
        "length_band": _len_band(row.get("prompt", "")),
        "dataset_release_date": "2023-11-15",
        "contamination_risk": "medium",
        "license": "apache-2.0",
        "source_label": "IFEval",
    }


def normalize_ifbench(row: dict) -> dict:
    prompt = row.get("prompt") or row.get("instruction") or row.get("input", "")
    return {
        "query": prompt,
        "expected_answer": {
            "type": "ifeval_constraint",
            "payload": {
                "instruction_id_list": row.get("instruction_id_list", []),
                "kwargs": row.get("kwargs", []),
                "key": row.get("key") or row.get("id"),
            },
        },
        "language": "en",
        "difficulty_band": "high",  # IFBench is harder than IFEval per design
        "length_band": _len_band(prompt),
        "dataset_release_date": "2024-12-01",
        "contamination_risk": "low",
        "license": "ODC-BY-1.0",
        "source_label": "IFBench",
    }


def normalize_livecodebench(row: dict) -> dict:
    question = row.get("question_content") or row.get("question") or ""
    starter = row.get("starter_code", "")
    full_query = f"{question}\n\n{starter}" if starter else question
    public_tests = row.get("public_test_cases", row.get("public_tests", []))
    private_tests = row.get("private_test_cases", row.get("private_tests", []))
    if isinstance(public_tests, str):
        try:
            public_tests = json.loads(public_tests)
        except Exception:
            pass
    if isinstance(private_tests, str):
        try:
            private_tests = json.loads(private_tests)
        except Exception:
            pass
    contest_date = row.get("contest_date", "")
    return {
        "query": full_query,
        "expected_answer": {
            "type": "test_cases",
            "payload": {
                "public_tests": public_tests,
                "private_tests": private_tests,  # may need hashing in 40_assemble
                "fn_name": row.get("metadata", {}).get("func_name") if isinstance(row.get("metadata"), dict) else None,
                "starter_code": starter,
                "platform": row.get("platform"),
                "difficulty": row.get("difficulty"),
            },
        },
        "language": "en",
        "difficulty_band": {"easy": "low", "medium": "med", "hard": "high"}.get(
            row.get("difficulty", "").lower(), "unknown"
        ),
        "length_band": _len_band(full_query),
        "dataset_release_date": str(contest_date)[:10] if contest_date else "2024-08-01",
        "contamination_risk": "low",  # v6 e' post-cutoff
        "license": "cc-by-4.0",
        "source_label": "LiveCodeBench-v6",
    }


def normalize_math500(row: dict) -> dict:
    problem = row.get("problem", "")
    solution = row.get("solution", "")
    answer = row.get("answer", "")
    level = row.get("level")
    band = "unknown"
    if isinstance(level, int | str):
        try:
            lv = int(str(level).replace("Level ", ""))
            band = "low" if lv <= 2 else ("med" if lv == 3 else "high")
        except Exception:
            band = "unknown"
    return {
        "query": problem,
        "expected_answer": {
            "type": "math_equivalent",
            "payload": {
                "final_answer": str(answer),
                "solution_latex": solution,
            },
        },
        "language": "en",
        "difficulty_band": band,
        "length_band": _len_band(problem),
        "dataset_release_date": "2024-01-01",
        "contamination_risk": "high",  # MATH e' notamente contaminato
        "license": "mit",
        "source_label": "MATH-500",
    }


def normalize_aime_2025(row: dict) -> dict:
    problem = row.get("question") or row.get("problem", "")
    answer = row.get("answer", "")
    return {
        "query": problem,
        "expected_answer": {
            "type": "math_equivalent",
            "payload": {
                "final_answer": str(answer),
                "solution_latex": row.get("solution", ""),
            },
        },
        "language": "en",
        "difficulty_band": "high",
        "length_band": _len_band(problem),
        "dataset_release_date": "2025-02-15",
        "contamination_risk": "low",  # post-cutoff
        "license": "mit",
        "source_label": "AIME-2025",
    }


def normalize_gsm8k(row: dict) -> dict:
    question = row.get("question", "")
    full_answer = row.get("answer", "")
    # GSM8K format: "...\n#### NUMBER"
    m = re.search(r"####\s*([-\d\.,/]+)", full_answer)
    final_answer = m.group(1).strip() if m else full_answer.strip()
    solution = full_answer.split("####")[0].strip() if "####" in full_answer else full_answer
    sol_len = len(solution)
    band = "low" if sol_len < 50 else ("med" if sol_len < 150 else "high")
    return {
        "query": question,
        "expected_answer": {
            "type": "exact_match",
            "payload": {
                "final_answer": final_answer,
                "solution_text": solution,
            },
        },
        "language": "en",
        "difficulty_band": band,
        "length_band": _len_band(question),
        "dataset_release_date": "2021-10-01",
        "contamination_risk": "high",
        "license": "mit",
        "source_label": "GSM8K",
    }


def normalize_simpleqa(row: dict) -> dict:
    problem = row.get("problem", "")
    return {
        "query": problem,
        "expected_answer": {
            "type": "llm_judge_factual",
            "payload": {
                "answer": row.get("answer", ""),
                "metadata": row.get("metadata", {}),
            },
        },
        "language": "en",
        "difficulty_band": "high",  # by design obscure
        "length_band": _len_band(problem),
        "dataset_release_date": "2024-10-30",
        "contamination_risk": "medium",
        "license": "mit",
        "source_label": "SimpleQA",
    }


def normalize_gpqa(row: dict) -> dict:
    question = row.get("Question") or row.get("question", "")
    correct = row.get("Correct Answer") or row.get("correct_answer", "")
    distractors = [
        row.get("Incorrect Answer 1"),
        row.get("Incorrect Answer 2"),
        row.get("Incorrect Answer 3"),
    ]
    distractors = [d for d in distractors if d is not None]
    return {
        "query": question,
        "expected_answer": {
            "type": "mcq_letter",
            "payload": {
                "correct": correct,
                "distractors": distractors,
                "subdomain": row.get("Subdomain") or row.get("subdomain"),
            },
        },
        "language": "en",
        "difficulty_band": "high",
        "length_band": _len_band(question),
        "dataset_release_date": "2023-11-20",
        "contamination_risk": "medium",
        "license": "cc-by-4.0",
        "source_label": "GPQA-Diamond",
        "gated": True,
    }


def normalize_mmlu_pro(row: dict) -> dict:
    question = row.get("question", "")
    options = row.get("options", [])
    answer_idx = row.get("answer_index", row.get("answer"))
    answer_letter = None
    if isinstance(answer_idx, int) and 0 <= answer_idx < 26:
        answer_letter = chr(ord("A") + answer_idx)
    elif isinstance(answer_idx, str) and len(answer_idx) == 1:
        answer_letter = answer_idx.upper()
    return {
        "query": question,
        "expected_answer": {
            "type": "mcq_letter",
            "payload": {
                "answer_letter": answer_letter,
                "answer_idx": answer_idx if isinstance(answer_idx, int) else None,
                "options": options,
                "category": row.get("category"),
            },
        },
        "language": "en",
        "difficulty_band": "high",
        "length_band": _len_band(question),
        "dataset_release_date": "2024-05-01",
        "contamination_risk": "high",
        "license": "mit",
        "source_label": "MMLU-Pro-Humanities",
    }


def normalize_eqbench_creative(row: dict) -> dict:
    prompt = row.get("prompt") or row.get("question") or ""
    iteration = row.get("iteration", 1)
    return {
        "query": prompt,
        "expected_answer": {
            "type": "rubric_judge",
            "payload": {
                "rubric_id": "eqbench_creative_v3_rubric",
                "judge": "rubric",
                "iteration": iteration,
                "genre_tag": row.get("genre_tag"),
            },
        },
        "language": "en",
        "difficulty_band": "med",
        "length_band": _len_band(prompt),
        "dataset_release_date": "2024-12-01",
        "contamination_risk": "low",
        "license": "see eqbench.com terms",
        "source_label": "EQ-Bench-Creative-v3",
    }


def normalize_litbench(row: dict) -> dict:
    """LitBench-Test schema: prompt + chosen_story / rejected_story (preference pair).

    Normalizziamo a single-output prendendo prompt come query, chosen_story come reference rubric anchor.
    """
    prompt = row.get("prompt") or row.get("writing_prompt", "")
    chosen = row.get("chosen_story") or row.get("chosen", "")
    return {
        "query": prompt,
        "expected_answer": {
            "type": "rubric_judge",
            "payload": {
                "rubric_id": "litbench_rubric",
                "judge": "rubric",
                "reference_chosen_story": chosen,  # anchor per judge
            },
        },
        "language": "en",
        "difficulty_band": "med",
        "length_band": _len_band(prompt),
        "dataset_release_date": "2024-06-01",
        "contamination_risk": "low",
        "license": "see-hf-card",
        "source_label": "LitBench-Test",
    }


def normalize_planning_custom(row: dict) -> dict:
    """Output di 13_planning_custom_generate (Regolo qwen3.5-122b)."""
    return {
        "query": row.get("prompt") or row.get("query", ""),
        "expected_answer": {
            "type": "rubric_judge",
            "payload": {
                "rubric_id": "planning_custom_rubric",
                "judge": "rubric",
                "category": row.get("category"),
                "validation_status": row.get("validation_status", "approved"),
            },
        },
        "language": "en",
        "difficulty_band": "high",  # planning multi-step e' inerentemente alto
        "length_band": _len_band(row.get("prompt", "")),
        "dataset_release_date": "2026-05-07",
        "contamination_risk": "low",
        "license": "qwen3.5-122b-output-derived",
        "source_label": "Planning-Custom",
    }


def normalize_creative_custom(row: dict) -> dict:
    """Output di generate_creative_custom (Regolo qwen3.5-122b) gia' tipizzato."""
    return {
        "query": row.get("prompt") or row.get("query", ""),
        "expected_answer": {
            "type": "rubric_judge",
            "payload": {
                "rubric_id": "creative_custom_rubric",
                "judge": "rubric",
                "genre_tag": row.get("genre_tag"),
                "validation_status": row.get("validation_status", "approved"),
            },
        },
        "language": "en",
        "difficulty_band": "med",
        "length_band": _len_band(row.get("prompt", "")),
        "dataset_release_date": "2026-05-07",
        "contamination_risk": "low",
        "license": "qwen3.5-122b-output-derived",
        "source_label": "Custom-Validated",
    }


def normalize_bfcl(row: dict) -> dict:
    question = row.get("question") or row.get("query", "")
    if isinstance(question, list):
        # BFCL multi-turn: prendi user message
        question = " ".join(
            m.get("content", "")
            for turn in question
            for m in (turn if isinstance(turn, list) else [turn])
            if isinstance(m, dict) and m.get("role") == "user"
        )
    category = row.get("_category") or row.get("category", "unknown")
    band = {
        "simple": "low",
        "multiple": "med",
        "parallel": "high",
        "parallel_multiple": "high",
        "irrelevance": "med",
    }.get(category, "unknown")
    return {
        "query": question,
        "expected_answer": {
            "type": "tool_call_match",
            "payload": {
                "ground_truth_calls": row.get("ground_truth", []),
                "function_specs": row.get("function", []),
                "category": category,
                "id": row.get("id"),
            },
        },
        "language": "en",
        "difficulty_band": band,
        "length_band": _len_band(question),
        "dataset_release_date": "2025-02-01",
        "contamination_risk": "low",
        "license": "apache-2.0",
        "source_label": "BFCL-v4",
    }


def normalize_bfcl_multi_turn(row: dict) -> dict:
    out = normalize_bfcl(row)
    out["source_label"] = "BFCL-v4-MT"
    out["expected_answer"]["payload"]["initial_config"] = row.get("initial_config")
    out["expected_answer"]["payload"]["involved_classes"] = row.get("involved_classes")
    return out


def normalize_taubench(row: dict) -> dict:
    instruction = row.get("instruction") or row.get("user_query", "")
    domain = row.get("_domain") or row.get("domain", "unknown")
    return {
        "query": instruction,
        "expected_answer": {
            "type": "tool_call_trajectory",
            "payload": {
                "task_id": str(row.get("task_id") or row.get("id", "")),
                "domain": domain,
                "tools_available": row.get("tools_available", []),
                "annotator": row.get("annotator"),
            },
        },
        "language": "en",
        "difficulty_band": "high",
        "length_band": _len_band(instruction),
        "dataset_release_date": "2024-06-01",
        "contamination_risk": "low",
        "license": "mit",
        "source_label": "tau-bench",
    }


def normalize_gaia(row: dict) -> dict:
    question = row.get("Question") or row.get("question", "")
    final = row.get("Final answer") or row.get("final_answer") or row.get("answer", "")
    level = row.get("Level") or row.get("level", 0)
    band = {1: "low", 2: "med", 3: "high"}.get(int(level) if str(level).isdigit() else 0, "unknown")
    return {
        "query": question,
        "expected_answer": {
            "type": "gaia_exact_match",
            "payload": {
                "final_answer": str(final),
                "level": int(level) if str(level).isdigit() else level,
                "task_id": row.get("task_id"),
                "annotator_metadata": row.get("Annotator Metadata"),
                "file_name": row.get("file_name"),
            },
        },
        "language": "en",
        "difficulty_band": band,
        "length_band": _len_band(question),
        "dataset_release_date": "2023-11-01",
        "contamination_risk": "low",
        "license": "GAIA terms",
        "source_label": "GAIA-L1L2",
        "gated": True,
    }


# === Registry ===

NORMALIZERS = {
    "ifeval": normalize_ifeval,
    "ifbench": normalize_ifbench,
    "livecodebench_v6": normalize_livecodebench,
    "math500": normalize_math500,
    "aime_2025": normalize_aime_2025,
    "gsm8k": normalize_gsm8k,
    "simpleqa": normalize_simpleqa,
    "gpqa_diamond": normalize_gpqa,
    "mmlu_pro_humanities": normalize_mmlu_pro,
    "eqbench_creative_v3": normalize_eqbench_creative,
    "litbench_test": normalize_litbench,
    "creative_custom": normalize_creative_custom,
    "bfcl_v4": normalize_bfcl,
    "bfcl_v4_multi_turn": normalize_bfcl_multi_turn,
    "tau_bench": normalize_taubench,
    "gaia": normalize_gaia,
    "planning_custom": normalize_planning_custom,
}


def normalize(source_id: str, row: dict) -> dict:
    fn = NORMALIZERS.get(source_id)
    if fn is None:
        raise KeyError(f"no normalizer for source_id '{source_id}'")
    return fn(row)
