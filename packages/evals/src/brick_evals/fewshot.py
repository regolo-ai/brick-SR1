"""Few-shot prompt builder. Estrae 5 esempi dal train split disgiunti dall'eval, formatta CoT."""

from __future__ import annotations

import random
from collections.abc import Iterable

from .io_utils import configs_dir, deterministic_hash, load_yaml


def _load_prompts() -> dict:
    return load_yaml(configs_dir() / "prompts.yaml")


def _render_template(template: str, ctx: dict) -> str:
    """Mini Jinja-like renderer: {{var}}, {%for x in xs%}...{%endfor%}, {{loop.index}}.

    Sufficiente per i template in prompts.yaml senza dipendenze extra.
    """
    import re

    # Loop blocks
    def replace_for(m):
        var = m.group(1)
        coll = m.group(2)
        body = m.group(3)
        items = ctx.get(coll, [])
        out = []
        for i, it in enumerate(items, start=1):
            local = {**ctx, var: it, "loop": {"index": i}}
            rendered = _render_template(body, local)
            out.append(rendered)
        return "".join(out)

    text = re.sub(
        r"\{%\s*for\s+(\w+)\s+in\s+(\w+)\s*%\}(.*?)\{%\s*endfor\s*%\}",
        replace_for,
        template,
        flags=re.DOTALL,
    )

    # Vars (incl. nested attribute like ex.question, loop.index)
    def replace_var(m):
        path = m.group(1).strip().split(".")
        v = ctx
        for p in path:
            if isinstance(v, dict):
                v = v.get(p, "")
            else:
                v = getattr(v, p, "")
        return str(v)

    text = re.sub(r"\{\{\s*([\w\.]+)\s*\}\}", replace_var, text)
    return text


def render_prompt(template_id: str, query: str, few_shot_examples: list[dict], **extra) -> str:
    """Render un template di prompts.yaml con query + few-shot examples."""
    prompts = _load_prompts()
    if template_id not in prompts:
        raise KeyError(f"template_id '{template_id}' not found in prompts.yaml")
    template = prompts[template_id]["template"]
    ctx = {"query": query, "few_shot_examples": few_shot_examples or [], **extra}
    return _render_template(template, ctx)


def select_template(dimension: str, source: str, shots: int) -> str:
    """Pick template_id basato su dimension/source/shots."""
    if shots == 0:
        if dimension == "planning_agentic":
            return "agentic_zero_shot"
        if source == "SimpleQA":
            return "simpleqa_zero_shot"
        return "agentic_zero_shot"  # fallback

    if dimension == "math_reasoning":
        return "fewshot_cot_math"
    if dimension == "coding":
        return "fewshot_cot_coding"
    if dimension == "world_knowledge" and source in ("MMLU-Pro-Humanities", "GPQA-Diamond"):
        return "fewshot_cot_mcq"
    if dimension == "creative_synthesis":
        return "fewshot_creative"
    if dimension == "instruction_following":
        return "fewshot_ifeval"
    return "fewshot_cot"


def sample_fewshot_pool(
    pool: Iterable[dict],
    k: int = 5,
    *,
    seed: int = 42,
    eval_query_hashes: set[str] | None = None,
    query_field: str = "question",
) -> list[dict]:
    """Sample k esempi dal pool, disgiunti dall'eval set via hash."""
    pool = list(pool)
    if eval_query_hashes:
        pool = [r for r in pool if deterministic_hash(r.get(query_field, "")) not in eval_query_hashes]
    rng = random.Random(seed)
    if len(pool) <= k:
        return pool[:]
    return rng.sample(pool, k)
