"""LLM-as-judge helper: rubric scoring, majority vote, position-swap, retry/backoff.

Backend: RegoloClient (qwen3.5-122b out-of-pool, no contamination con qwen3.5-9b/deepseek-v4-flash/kimi2.6).
"""

from __future__ import annotations

import json
import time
from collections import Counter
from collections.abc import Callable
from typing import Any

from .regolo_client import RegoloClient


def _strip_fences(text: str) -> str:
    text = text.strip()
    if text.startswith("```"):
        lines = text.splitlines()
        if lines[0].startswith("```"):
            lines = lines[1:]
        if lines and lines[-1].startswith("```"):
            lines = lines[:-1]
        text = "\n".join(lines).strip()
    return text


def parse_json_object(text: str) -> dict | None:
    text = _strip_fences(text)
    start = text.find("{")
    end = text.rfind("}")
    if start == -1 or end == -1 or end <= start:
        return None
    try:
        return json.loads(text[start : end + 1])
    except json.JSONDecodeError:
        return None


def parse_score_rubric(text: str, axes: list[str]) -> dict | None:
    """Parse rubric output. Expected JSON: {axis_name: int 1-5, ..., "verdict": "pass"|"fail", "rationale": str}."""
    obj = parse_json_object(text)
    if obj is None:
        return None
    out = {}
    for ax in axes:
        v = obj.get(ax)
        if isinstance(v, int | float) and 1 <= v <= 5:
            out[ax] = int(v)
        else:
            return None
    out["verdict"] = obj.get("verdict", "")
    out["rationale"] = obj.get("rationale", "")[:500]
    return out


def majority_vote(verdicts: list[str]) -> str:
    """Majority vote on string verdicts. Tie → 'ambiguous'."""
    counts = Counter(verdicts)
    if not counts:
        return "ambiguous"
    top = counts.most_common(2)
    if len(top) > 1 and top[0][1] == top[1][1]:
        return "ambiguous"
    return top[0][0]


def avg_scores(rubrics: list[dict], axes: list[str]) -> dict[str, float]:
    out = {}
    for ax in axes:
        vals = [r[ax] for r in rubrics if ax in r]
        out[ax] = round(sum(vals) / len(vals), 2) if vals else 0.0
    return out


class Judge:
    """Wrap RegoloClient with rubric scoring + 3-judge majority + position swap.

    Uses temperature variation across N judges for diversity (no random seed control on Regolo).
    """

    def __init__(self, client: RegoloClient | None = None, n_judges: int = 3):
        self.client = client or RegoloClient()
        self.n_judges = n_judges
        self.temps = [0.2, 0.5, 0.8][:n_judges]

    def score(
        self,
        rubric_prompt: str,
        axes: list[str],
        *,
        system: str = "You are a meticulous evaluator. Output only valid JSON, no markdown.",
        max_tokens: int = 1024,
    ) -> dict:
        """Run N judges, return aggregate {scores: {axis: avg}, verdict: majority, raw: [...], n_parsed: int}."""
        rubrics = []
        raw_responses = []
        for t in self.temps:
            try:
                out = self.client.text(rubric_prompt, system=system, temperature=t, max_tokens=max_tokens)
                raw_responses.append(out)
                parsed = parse_score_rubric(out, axes)
                if parsed:
                    rubrics.append(parsed)
            except Exception as e:
                raw_responses.append(f"[error: {type(e).__name__}: {str(e)[:200]}]")

        verdicts = [r["verdict"] for r in rubrics if r.get("verdict")]
        return {
            "scores": avg_scores(rubrics, axes),
            "verdict": majority_vote(verdicts) if verdicts else "ambiguous",
            "n_parsed": len(rubrics),
            "n_judges": self.n_judges,
            "raw": raw_responses,
            "rubrics": rubrics,
        }

    def binary(self, prompt: str, *, system: str = "Output only YES or NO.", max_tokens: int = 8) -> dict:
        """Binary YES/NO 3-judge majority. Returns {verdict, n_parsed, raw}."""
        votes = []
        raw = []
        for t in self.temps:
            try:
                out = self.client.text(prompt, system=system, temperature=t, max_tokens=max_tokens).upper()
                raw.append(out)
                if "YES" in out:
                    votes.append("YES")
                elif "NO" in out:
                    votes.append("NO")
            except Exception as e:
                raw.append(f"[err: {type(e).__name__}]")
        return {
            "verdict": majority_vote(votes) if votes else "ambiguous",
            "n_parsed": len(votes),
            "n_judges": self.n_judges,
            "raw": raw,
        }


def run_with_retry(fn: Callable, *args, max_attempts: int = 3, backoff: float = 2.0, **kwargs) -> Any:
    """Generic retry wrapper for Regolo calls with exponential backoff."""
    last_err = None
    for attempt in range(max_attempts):
        try:
            return fn(*args, **kwargs)
        except Exception as e:
            last_err = e
            if attempt < max_attempts - 1:
                time.sleep(backoff**attempt)
    raise last_err
