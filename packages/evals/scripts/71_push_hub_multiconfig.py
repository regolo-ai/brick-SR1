#!/usr/bin/env python3
"""71 - Push HF Hub multi-config (1 per dimension + 'all').

Configs:
- all (5339 rows)
- coding (1000), math_reasoning (1000), planning_agentic (1000)
- instruction_following (841), world_knowledge (802), creative_synthesis (696)

Usage:
    python3 scripts/71_push_hub_multiconfig.py
"""

from __future__ import annotations

import copy
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from brick_evals.io_utils import configs_dir, data_dir, hf_token, load_jsonl, load_yaml, save_jsonl

REPO_ID = "massaindustries/dataset-A-routing-eval"
DIMENSIONS = [
    "coding",
    "math_reasoning",
    "planning_agentic",
    "instruction_following",
    "world_knowledge",
    "creative_synthesis",
]


def mask_gated_rows(rows: list[dict]) -> list[dict]:
    out = []
    for r in rows:
        if r.get("gated"):
            r2 = copy.deepcopy(r)
            r2["query"] = "<masked>"
            ea = r2["expected_answer"]
            ea["payload"] = "<masked>"
            ea["type"] = "masked"
            r2["few_shot_examples"] = []
            out.append(r2)
        else:
            out.append(r)
    return out


def serialize_for_arrow(rows: list[dict]) -> list[dict]:
    out = []
    for r in rows:
        r2 = dict(r)
        r2["expected_answer"] = json.dumps(r["expected_answer"], ensure_ascii=False)
        r2["few_shot_examples"] = json.dumps(r.get("few_shot_examples", []), ensure_ascii=False)
        out.append(r2)
    return out


def make_dataset_card(rows: list[dict], by_dim: dict) -> str:
    from collections import Counter

    by_src = Counter(r["source"] for r in rows)
    n_gated = sum(1 for r in rows if r.get("gated"))
    sources_yaml = load_yaml(configs_dir() / "sources.yaml")

    lines = []
    # YAML frontmatter with multi-config metadata
    lines.append("---")
    lines.append("license: other")
    lines.append("license_name: mixed-license-see-per-source")
    lines.append("language:")
    lines.append("  - en")
    lines.append("tags:")
    lines.append("  - routing")
    lines.append("  - evaluation")
    lines.append("  - llm-router")
    lines.append("  - multi-domain")
    lines.append("size_categories:")
    lines.append("  - 1K<n<10K")
    lines.append("configs:")
    # Default config: all
    lines.append("  - config_name: all")
    lines.append("    default: true")
    lines.append("    data_files:")
    lines.append("      - split: train")
    lines.append("        path: data/all/train.jsonl")
    for dim in DIMENSIONS:
        lines.append(f"  - config_name: {dim}")
        lines.append("    data_files:")
        lines.append("      - split: train")
        lines.append(f"        path: data/{dim}/train.jsonl")
    lines.append("---")
    lines.append("")
    lines.append("# Dataset A - Routing Evaluation")
    lines.append("")
    lines.append(f"**Total rows:** {len(rows)} | **Gated (masked) rows:** {n_gated}")
    lines.append("")
    lines.append("Stratified dataset to evaluate 3 LLM models and 3 routing systems across 6 capabilities.")
    lines.append("")
    lines.append("## Multi-config layout")
    lines.append("")
    lines.append("```python")
    lines.append("from datasets import load_dataset")
    lines.append("")
    lines.append("# Full dataset")
    lines.append('ds = load_dataset("massaindustries/dataset-A-routing-eval", "all")')
    lines.append("")
    lines.append("# Per dimension")
    lines.append('ds_math = load_dataset("massaindustries/dataset-A-routing-eval", "math_reasoning")')
    lines.append('ds_code = load_dataset("massaindustries/dataset-A-routing-eval", "coding")')
    lines.append("# ... idem per planning_agentic, instruction_following, world_knowledge, creative_synthesis")
    lines.append("```")
    lines.append("")
    lines.append("## Model pool (for token metadata)")
    lines.append("")
    lines.append("| Alias | HF Tokenizer | Note |")
    lines.append("|---|---|---|")
    lines.append("| qwen3.5-9b | `Qwen/Qwen3.5-9B` | official tokenizer, exact token count |")
    lines.append("| deepseek-v4-flash | `deepseek-ai/DeepSeek-V3` (proxy) | expected mismatch ±2-5% |")
    lines.append("| kimi2.6 | `moonshotai/Kimi-K2.5` (proxy) | expected mismatch ±2-5% |")
    lines.append("")
    lines.append("## Composition")
    lines.append("")
    lines.append("### By dimension (configs)")
    lines.append("| config | rows |")
    lines.append("|---|---|")
    lines.append(f"| `all` | {len(rows)} |")
    for dim in DIMENSIONS:
        lines.append(f"| `{dim}` | {by_dim.get(dim, 0)} |")
    lines.append("")
    lines.append("### By source")
    lines.append("| source | count | license | gated |")
    lines.append("|---|---|---|---|")
    for s, c in sorted(by_src.items()):
        lic = "?"
        gated = False
        for _sid, scfg in sources_yaml.items():
            if isinstance(scfg, dict) and scfg.get("source_label") == s:
                lic = scfg.get("license", "?")
                gated = scfg.get("gated", False)
                break
        lines.append(f"| `{s}` | {c} | {lic} | {'yes' if gated else 'no'} |")
    lines.append("")
    lines.append("## Schema")
    lines.append("")
    lines.append("```json")
    lines.append(
        json.dumps(
            {
                "query_id": "q_NNNNN",
                "query": "string (full prompt, includes few-shot if shots=5)",
                "dimension": "instruction_following | coding | math_reasoning | world_knowledge | creative_synthesis | planning_agentic",
                "source": "source_label",
                "shots": "int (5 or 0)",
                "input_tokens_qwen": "int",
                "input_tokens_deepseek": "int",
                "input_tokens_kimi": "int",
                "expected_answer": "JSON-encoded string {type, payload}",
                "few_shot_examples": "JSON-encoded string list[dict]",
                "evaluation_protocol_id": "string",
                "gated": "bool (true → query='<masked>' for license compliance)",
                "license": "per-source",
                "length_band": "short|med|long",
            },
            indent=2,
        )
    )
    lines.append("```")
    lines.append("")
    lines.append("All prompts and few-shot examples are in **English**.")
    lines.append("")
    lines.append("## Reproducibility caveats")
    lines.append("")
    lines.append(
        "- Tokens: Qwen tokenizer is official (exact). DeepSeek + Kimi are proxies via V3 / K2.5 → mismatch ±2-5%."
    )
    lines.append(
        "- Custom creative (`Custom-Validated`): generated via Regolo `qwen3.5-122b` (out-of-pool). SHA256 in `lockfile.yaml`."
    )
    lines.append(
        "- Synthetic few-shot pools (MATH-500, AIME-2025, LiveCodeBench-v6, IFEval, GPQA-Diamond, EQ-Bench-Creative-v3): generated by Regolo qwen3.5-122b with judge-based quality filtering. SHA256 in `lockfile.yaml`."
    )
    lines.append(
        "- IFEval few-shot: real prompts from `google/IFEval` test split + LLM-generated answers (verifier-checked)."
    )
    lines.append(
        "- Gated datasets (`GAIA-L1L2`, `GPQA-Diamond`): query masked (`query='<masked>'`) for license compliance."
    )
    lines.append("")
    lines.append("## Citation")
    lines.append("")
    lines.append("Cite each original source (see `lockfile.yaml`).")
    return "\n".join(lines)


def main():
    full_path = data_dir("final") / "evaluation_parameters_full.jsonl"
    rows = list(load_jsonl(full_path))
    print(f"loaded {len(rows)} rows")

    masked_rows = mask_gated_rows(rows)

    # Group by dimension
    by_dim_rows: dict = {d: [] for d in DIMENSIONS}
    for r in masked_rows:
        by_dim_rows[r["dimension"]].append(r)

    by_dim = {d: len(by_dim_rows[d]) for d in DIMENSIONS}
    print(f"by_dim: {by_dim}")

    # Save serialized jsonl for each config
    out_dir = data_dir("final", "hub_split")
    for sub in ["all"] + DIMENSIONS:
        (out_dir / sub).mkdir(parents=True, exist_ok=True)

    serialized_all = serialize_for_arrow(masked_rows)
    save_jsonl(out_dir / "all" / "train.jsonl", serialized_all)
    for dim in DIMENSIONS:
        save_jsonl(out_dir / dim / "train.jsonl", serialize_for_arrow(by_dim_rows[dim]))
    print(f"saved {len(DIMENSIONS) + 1} jsonl configs in {out_dir}")

    # Dataset card
    card = make_dataset_card(masked_rows, by_dim)
    card_path = data_dir("final") / "dataset_card_multiconfig.md"
    card_path.write_text(card, encoding="utf-8")
    print(f"saved dataset card → {card_path}")

    # Push
    from huggingface_hub import HfApi, login

    login(token=hf_token())
    api = HfApi(token=hf_token())
    print(f"creating repo {REPO_ID}...")
    api.create_repo(repo_id=REPO_ID, repo_type="dataset", private=False, exist_ok=True)

    # Upload all jsonl files preserving folder structure
    print("uploading config files...")
    for sub in ["all"] + DIMENSIONS:
        local = out_dir / sub / "train.jsonl"
        remote = f"data/{sub}/train.jsonl"
        print(f"  {local} → {remote}")
        api.upload_file(
            path_or_fileobj=str(local),
            path_in_repo=remote,
            repo_id=REPO_ID,
            repo_type="dataset",
            commit_message=f"Dataset A v0.3.0 multi-config ({sub})",
        )

    # README
    api.upload_file(
        path_or_fileobj=str(card_path),
        path_in_repo="README.md",
        repo_id=REPO_ID,
        repo_type="dataset",
        commit_message="add multi-config dataset card",
    )
    # Lockfile
    api.upload_file(
        path_or_fileobj=str(data_dir("reports") / "lockfile.yaml"),
        path_in_repo="lockfile.yaml",
        repo_id=REPO_ID,
        repo_type="dataset",
        commit_message="update lockfile",
    )

    print(f"\nDONE. Visit: https://huggingface.co/datasets/{REPO_ID}")


if __name__ == "__main__":
    main()
