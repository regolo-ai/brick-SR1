"""Schema target `evaluation_parameters` con validation (rev.3 - schema clean)."""

from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Any, Literal

ExpectedAnswerType = Literal[
    "test_cases",
    "exact_match",
    "math_equivalent",
    "tool_call_match",
    "tool_call_trajectory",
    "rubric_judge",
    "llm_judge_factual",
    "gaia_exact_match",
    "ifeval_constraint",
    "mcq_letter",
    "masked",
]

DimensionType = Literal[
    "instruction_following",
    "coding",
    "math_reasoning",
    "world_knowledge",
    "creative_synthesis",
    "planning_agentic",
]

LengthBand = Literal["short", "med", "long"]


@dataclass
class ExpectedAnswer:
    type: ExpectedAnswerType
    payload: Any  # JSON-serializable


@dataclass
class FewShotExample:
    question: str
    reasoning: str
    final_answer: str
    options_formatted: str | None = None  # for MCQ


@dataclass
class EvaluationParameters:
    query_id: str  # q_NNNNN
    query: str
    dimension: DimensionType
    source: str
    shots: int
    input_tokens_qwen: int
    input_tokens_deepseek: int
    input_tokens_kimi: int
    expected_answer: dict  # {"type": ..., "payload": ...}
    few_shot_examples: list[dict]
    evaluation_protocol_id: str
    gated: bool = False
    license: str = "unknown"
    length_band: LengthBand = "med"

    def to_dict(self) -> dict:
        return asdict(self)


REQUIRED_FIELDS = {
    "query_id",
    "query",
    "dimension",
    "source",
    "shots",
    "input_tokens_qwen",
    "input_tokens_deepseek",
    "input_tokens_kimi",
    "expected_answer",
    "few_shot_examples",
    "evaluation_protocol_id",
    "gated",
    "license",
    "length_band",
}

ALLOWED_DIMENSIONS = {
    "instruction_following",
    "coding",
    "math_reasoning",
    "world_knowledge",
    "creative_synthesis",
    "planning_agentic",
}

ALLOWED_EXPECTED_TYPES = {
    "test_cases",
    "exact_match",
    "math_equivalent",
    "tool_call_match",
    "tool_call_trajectory",
    "rubric_judge",
    "llm_judge_factual",
    "gaia_exact_match",
    "ifeval_constraint",
    "mcq_letter",
    "masked",
}


def validate_row(row: dict, *, allow_unmasked_token_count: bool = True) -> list[str]:
    """Ritorna lista di errori di validazione (vuota se OK)."""
    errors = []
    missing = REQUIRED_FIELDS - row.keys()
    if missing:
        errors.append(f"missing fields: {sorted(missing)}")

    if (d := row.get("dimension")) and d not in ALLOWED_DIMENSIONS:
        errors.append(f"invalid dimension: {d}")

    if (qid := row.get("query_id")) and not (qid.startswith("q_") and len(qid) == 7):
        errors.append(f"query_id must be q_NNNNN (got {qid})")

    ea = row.get("expected_answer")
    if not isinstance(ea, dict):
        errors.append("expected_answer must be dict")
    else:
        if "type" not in ea or "payload" not in ea:
            errors.append("expected_answer must have keys 'type' and 'payload'")
        elif ea["type"] not in ALLOWED_EXPECTED_TYPES:
            errors.append(f"invalid expected_answer.type: {ea['type']}")

    shots = row.get("shots")
    if shots is not None and not isinstance(shots, int):
        errors.append("shots must be int")

    if row.get("gated") and row.get("query") != "<masked>" and not allow_unmasked_token_count:
        errors.append("gated row should have query='<masked>' for public push")

    for tk in ("input_tokens_qwen", "input_tokens_deepseek", "input_tokens_kimi"):
        v = row.get(tk)
        if v is not None and not isinstance(v, int):
            errors.append(f"{tk} must be int (got {type(v).__name__})")

    return errors
