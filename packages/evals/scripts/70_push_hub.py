#!/usr/bin/env python3
"""70 - Push HF Hub: due variants + dataset card.

- evaluation_parameters_full.jsonl (gitignored, locale, contiene gated)
- evaluation_parameters_masked.jsonl (push pubblico; GAIA/GPQA query='<masked>')

Repo: massaindustries/dataset-A-routing-eval (public).
"""

from __future__ import annotations

import copy
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from brick_evals.io_utils import configs_dir, data_dir, hf_token, load_jsonl, load_yaml, save_jsonl

REPO_ID = "massaindustries/dataset-A-routing-eval"


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
    """Serializza expected_answer + few_shot_examples come JSON string (pyarrow uniform schema)."""
    out = []
    for r in rows:
        r2 = dict(r)
        r2["expected_answer"] = json.dumps(r["expected_answer"], ensure_ascii=False)
        r2["few_shot_examples"] = json.dumps(r.get("few_shot_examples", []), ensure_ascii=False)
        out.append(r2)
    return out


def make_dataset_card(rows: list[dict]) -> str:
    from collections import Counter

    by_dim = Counter(r["dimension"] for r in rows)
    by_src = Counter(r["source"] for r in rows)
    n_gated = sum(1 for r in rows if r.get("gated"))

    sources_yaml = load_yaml(configs_dir() / "sources.yaml")

    lines = []
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
    lines.append("---")
    lines.append("")
    lines.append("# Dataset A - Routing Evaluation")
    lines.append("")
    lines.append(f"**Total rows:** {len(rows)} | **Gated (masked) rows:** {n_gated}")
    lines.append("")
    lines.append("Dataset stratificato per valutare 3 modelli LLM e 3 sistemi di routing su 6 capability.")
    lines.append("")
    lines.append("## Pool modelli (per metadata tokens)")
    lines.append("")
    lines.append("| Alias | Tokenizer HF | Note |")
    lines.append("|---|---|---|")
    lines.append("| qwen3.5-9b | `Qwen/Qwen3.5-9B` | tokenizer ufficiale, tokens count esatto |")
    lines.append("| deepseek-v4-flash | `deepseek-ai/DeepSeek-V3` (proxy) | mismatch atteso ±2-5% |")
    lines.append("| kimi2.6 | `moonshotai/Kimi-K2.5` (proxy) | mismatch atteso ±2-5% |")
    lines.append("")
    lines.append("## Composizione")
    lines.append("")
    lines.append("### Per dimension")
    lines.append("| dimension | count |")
    lines.append("|---|---|")
    for d, c in sorted(by_dim.items()):
        lines.append(f"| `{d}` | {c} |")
    lines.append("")
    lines.append("### Per source")
    lines.append("| source | count | license | gated |")
    lines.append("|---|---|---|---|")
    for s, c in sorted(by_src.items()):
        # find license from sources.yaml by source_label
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
                "query": "string (prompt completo, incluso few-shot)",
                "dimension": "instruction_following | coding | math_reasoning | world_knowledge | creative_synthesis | planning_agentic",
                "source": "source_label",
                "shots": "int (5 o 0)",
                "input_tokens_qwen": "int",
                "input_tokens_deepseek": "int",
                "input_tokens_kimi": "int",
                "expected_answer": {
                    "type": "discriminated union",
                    "payload": "typed per type (JSON-encoded for Arrow uniform schema)",
                },
                "few_shot_examples": "list[dict] (JSON-encoded for Arrow uniform schema)",
                "evaluation_protocol_id": "string (vedi protocols.yaml)",
                "gated": "bool (true = query='<masked>' for GAIA/GPQA license compliance)",
                "license": "per-source",
                "length_band": "short|med|long",
            },
            indent=2,
        )
    )
    lines.append("```")
    lines.append("")

    lines.append("## Reproducibility caveats")
    lines.append("")
    lines.append(
        "- Tokens: Qwen tokenizer ufficiale (esatto). DeepSeek + Kimi sono proxy via V3 / K2.5 → mismatch ±2-5%."
    )
    lines.append(
        "- Creative custom (`Custom-Validated`): generato via Regolo `qwen3.5-122b` (fuori-pool). Anthropic API non supporta seed; il file `generated.jsonl` è input statico (SHA256 in lockfile)."
    )
    lines.append(
        "- Gated datasets (`GAIA-L1L2`, `GPQA-Diamond`): query mascherate (`query='<masked>'`) per compliance license. Per ripopolare con i prompt originali, accept terms on HF UI per i source dataset, poi run `99_unmask_gated.py` localmente."
    )
    lines.append("")

    lines.append("## Citation")
    lines.append("")
    lines.append("Cita ogni source originale (vedi `lockfile.yaml`).")
    return "\n".join(lines)


def main():
    full_path = data_dir("final") / "evaluation_parameters_full.jsonl"
    rows = list(load_jsonl(full_path))
    print(f"loaded {len(rows)} rows")

    # Mask gated
    masked_rows = mask_gated_rows(rows)
    masked_path = data_dir("final") / "evaluation_parameters_masked.jsonl"
    save_jsonl(masked_path, masked_rows)
    print(f"saved masked variant -> {masked_path}")

    # Dataset card
    card = make_dataset_card(masked_rows)
    card_path = data_dir("final") / "dataset_card.md"
    card_path.write_text(card, encoding="utf-8")
    print(f"saved dataset card -> {card_path}")

    # Push
    from huggingface_hub import HfApi, login

    login(token=hf_token())

    # Serialize for arrow-uniform schema and write JSONL (memory-efficient)
    serialized = serialize_for_arrow(masked_rows)
    serialized_path = data_dir("final") / "evaluation_parameters_masked_serialized.jsonl"
    save_jsonl(serialized_path, serialized)
    del serialized
    del masked_rows

    api = HfApi(token=hf_token())
    print(f"creating repo {REPO_ID}...")
    api.create_repo(repo_id=REPO_ID, repo_type="dataset", private=False, exist_ok=True)

    print("uploading data file...")
    api.upload_file(
        path_or_fileobj=str(serialized_path),
        path_in_repo="data/train.jsonl",
        repo_id=REPO_ID,
        repo_type="dataset",
        commit_message="Dataset A v0.1.0 (masked)",
    )
    api.upload_file(
        path_or_fileobj=str(card_path),
        path_in_repo="README.md",
        repo_id=REPO_ID,
        repo_type="dataset",
        commit_message="add dataset card",
    )
    api.upload_file(
        path_or_fileobj=str(data_dir("reports") / "lockfile.yaml"),
        path_in_repo="lockfile.yaml",
        repo_id=REPO_ID,
        repo_type="dataset",
        commit_message="add lockfile",
    )

    print(f"\nDONE. Visit: https://huggingface.co/datasets/{REPO_ID}")


if __name__ == "__main__":
    main()
