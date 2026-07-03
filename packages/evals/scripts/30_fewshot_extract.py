#!/usr/bin/env python3
"""30 - Few-shot extract: 5 esempi/dimension dal train split (con fallback).

Output: data/fewshot_pools/<source_id>.json (5 esempi pre-formattati)

Strategia:
- Per source con shots > 0, carica fewshot_pool da configs/sources.yaml
- Disgiunzione hash dall'eval set (raw query)
- Random sample con seed=42
- Estrazione campi (question, reasoning, final_answer) per dimension-specific
"""

from __future__ import annotations

import json
import random
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from brick_evals.io_utils import configs_dir, data_dir, deterministic_hash, hf_token, load_jsonl, load_yaml

K = 5
SEED = 42


def _eval_hashes(source_id: str, query_field: str = "query") -> set[str]:
    """Hash delle query nell'eval set, per disgiunzione."""
    raw_path = data_dir("raw") / f"{source_id}.jsonl"
    if not raw_path.exists():
        return set()
    out = set()
    for r in load_jsonl(raw_path):
        # heuristic field detection
        for f in (query_field, "question", "problem", "prompt", "Question"):
            if f in r:
                out.add(deterministic_hash(r[f]))
                break
    return out


def _load_pool(pool_cfg: dict) -> list[dict]:
    from datasets import load_dataset

    repo = pool_cfg["repo"]
    cfg = pool_cfg.get("config")
    split = pool_cfg.get("split", "train")
    kw = {"path": repo, "split": split, "token": hf_token(), "trust_remote_code": False}
    if cfg:
        kw["name"] = cfg
    ds = load_dataset(**kw)
    return list(ds)


def _extract_example(source_id: str, row: dict) -> dict:
    """Estrai (question, reasoning, final_answer) per dimension-specific."""
    if source_id in ("math500", "aime_2025"):
        return {
            "question": row.get("problem", ""),
            "reasoning": row.get("solution", ""),
            "final_answer": str(row.get("answer", "")),
        }
    if source_id == "gsm8k":
        full = row.get("answer", "")
        if "####" in full:
            sol, fa = full.split("####", 1)
            return {"question": row.get("question", ""), "reasoning": sol.strip(), "final_answer": fa.strip()}
        return {"question": row.get("question", ""), "reasoning": "", "final_answer": full.strip()}
    if source_id == "livecodebench_v6":
        return {
            "question": row.get("question_content", row.get("question", "")),
            "reasoning": "Approach: parse input, apply algorithm, output result.",
            "final_answer": row.get("starter_code", "# solution code here"),
        }
    if source_id in ("ifeval", "ifbench"):
        return {
            "question": row.get("prompt", ""),
            "reasoning": "",
            "final_answer": "[Risposta di esempio che soddisfa i constraint]",
        }
    if source_id == "mmlu_pro_humanities":
        opts = row.get("options", [])
        opts_fmt = "\n".join(f"{chr(65 + i)}. {o}" for i, o in enumerate(opts))
        idx = row.get("answer_index")
        letter = chr(65 + idx) if isinstance(idx, int) else str(row.get("answer", ""))
        return {
            "question": row.get("question", ""),
            "options_formatted": opts_fmt,
            "reasoning": row.get("cot_content", ""),
            "final_answer": letter,
        }
    if source_id == "gpqa_diamond":
        opts = [
            row.get("Correct Answer"),
            row.get("Incorrect Answer 1"),
            row.get("Incorrect Answer 2"),
            row.get("Incorrect Answer 3"),
        ]
        opts = [o for o in opts if o]
        rng = random.Random(deterministic_hash(row.get("Question", ""), 8))
        rng.shuffle(opts)
        opts_fmt = "\n".join(f"{chr(65 + i)}. {o}" for i, o in enumerate(opts))
        correct = row.get("Correct Answer", "")
        try:
            letter = chr(65 + opts.index(correct))
        except ValueError:
            letter = "A"
        return {
            "question": row.get("Question", ""),
            "options_formatted": opts_fmt,
            "reasoning": row.get("Explanation", ""),
            "final_answer": letter,
        }
    if source_id in ("eqbench_creative_v3", "litbench_test"):
        return {
            "question": row.get("prompt", row.get("writing_prompt", "")),
            "reasoning": "",
            "final_answer": row.get("chosen_story", row.get("response", "")),
        }
    # Fallback generic
    return {
        "question": row.get("question") or row.get("prompt") or row.get("problem") or "",
        "reasoning": "",
        "final_answer": str(row.get("answer", "")),
    }


def extract_for_source(source_id: str, source_cfg: dict) -> list[dict] | None:
    pool_cfg = source_cfg.get("fewshot_pool")
    if not pool_cfg or source_cfg.get("shots", 0) == 0:
        return None

    print(f"\n=== {source_id} ===")
    print(f"  pool: {pool_cfg}")
    eval_hashes = _eval_hashes(source_id)
    print(f"  eval hashes: {len(eval_hashes)}")

    try:
        pool = _load_pool(pool_cfg)
    except Exception as e:
        print(f"  [FAIL] cannot load pool: {type(e).__name__}: {str(e)[:120]}")
        return None

    # Filter disgiunzione (best-effort sui field plausibili)
    def _q_of(r):
        for f in ("question", "problem", "prompt", "Question", "writing_prompt", "question_content"):
            if f in r:
                return r[f]
        return ""

    filtered = [r for r in pool if deterministic_hash(_q_of(r)) not in eval_hashes]
    rng = random.Random(SEED)
    sample = rng.sample(filtered, min(K, len(filtered))) if filtered else []
    print(f"  sampled {len(sample)} from pool of {len(filtered)} (after disgiunzione)")

    examples = [_extract_example(source_id, r) for r in sample]
    return examples


def main():
    sources = load_yaml(configs_dir() / "sources.yaml")
    out_dir = data_dir("fewshot_pools")

    for sid, cfg in sources.items():
        if sid.startswith("_") or not isinstance(cfg, dict):
            continue
        examples = extract_for_source(sid, cfg)
        if examples is None:
            continue
        out = out_dir / f"{sid}.json"
        with open(out, "w", encoding="utf-8") as f:
            json.dump(examples, f, ensure_ascii=False, indent=2)
        print(f"  saved -> {out}")

    print("\nDone.")


if __name__ == "__main__":
    main()
