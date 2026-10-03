#!/usr/bin/env python3
"""73 - Mirror dataset_A_routing pre-built artifacts to regolo/brick2-dataset-a-eval.

Splits each of 3 configs (evals/results/verbose) into 6 dimension splits
(coding/creative_synthesis/instruction_following/math_reasoning/planning_agentic/world_knowledge),
merging planning_agentic_multiturn -> planning_agentic.

Atomic single-commit replaces the legacy v0.3 layout with v0.4 (3 configs x 6 splits).

Usage:
    python3 scripts/73_push_regolo_mirror.py --dry-run   # split + plan, no push
    python3 scripts/73_push_regolo_mirror.py             # split + atomic push
"""

from __future__ import annotations

import argparse
import gzip
import json
import shutil
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from brick_evals.io_utils import data_dir, hf_token

REPO_ID = "regolo/brick2-dataset-a-eval"
CONFIGS = ("evals", "results", "verbose")
DIMENSIONS = (
    "coding",
    "creative_synthesis",
    "instruction_following",
    "math_reasoning",
    "planning_agentic",
    "world_knowledge",
)
DIM_REMAP = {"planning_agentic_multiturn": "planning_agentic"}
SCHEMA_ANCHOR_ID = "_schema_anchor"


def split_config(src_jsonl_gz: Path, out_dir: Path) -> dict[str, int]:
    """Read src jsonl.gz, group by dimension, write one jsonl.gz per dim with anchor row first."""
    anchor = None
    by_dim: dict[str, list[str]] = {d: [] for d in DIMENSIONS}

    with gzip.open(src_jsonl_gz, "rt", encoding="utf-8") as f:
        for raw_line in f:
            line = raw_line.rstrip("\n")
            if not line:
                continue
            row = json.loads(line)
            qid = row.get("query_id")
            if qid == SCHEMA_ANCHOR_ID:
                anchor = line
                continue
            dim = row.get("dimension")
            dim = DIM_REMAP.get(dim, dim)
            if dim not in by_dim:
                raise RuntimeError(f"unexpected dimension {dim!r} in {src_jsonl_gz}")
            by_dim[dim].append(line)

    if anchor is None:
        raise RuntimeError(f"schema anchor not found in {src_jsonl_gz}")

    out_dir.mkdir(parents=True, exist_ok=True)
    counts: dict[str, int] = {}
    for dim, lines in by_dim.items():
        out_path = out_dir / f"{dim}.jsonl.gz"
        with gzip.open(out_path, "wt", encoding="utf-8") as g:
            g.write(anchor + "\n")
            for ln in lines:
                g.write(ln + "\n")
        counts[dim] = len(lines)
    return counts


def render_readme(stats_json: dict, by_dim_counts: dict[str, int]) -> str:
    n = stats_json["total"]
    win = stats_json["win_rate"]
    abst = stats_json["abstention"]

    lines: list[str] = []
    lines.append("---")
    lines.append("license: cc-by-4.0")
    lines.append("language:")
    lines.append("  - en")
    lines.append("tags:")
    lines.append("  - routing")
    lines.append("  - evaluation")
    lines.append("  - llm-router")
    lines.append("  - multi-domain")
    lines.append("  - model-comparison")
    lines.append("size_categories:")
    lines.append("  - 1K<n<10K")
    lines.append("configs:")
    for i, cfg in enumerate(CONFIGS):
        lines.append(f"  - config_name: {cfg}")
        if i == 0:
            lines.append("    default: true")
        lines.append("    data_files:")
        for dim in DIMENSIONS:
            lines.append(f"      - split: {dim}")
            lines.append(f"        path: data/{cfg}/{dim}.jsonl.gz")
    lines.append("---")
    lines.append("")
    lines.append("# Brick2 Dataset A - Routing Evaluation (regolo mirror)")
    lines.append("")
    lines.append(f"**Total queries:** {n} | **Gated (masked):** {stats_json['n_gated']}")
    lines.append("")
    lines.append("Stratified routing-evaluation benchmark over 6 capability dimensions.")
    lines.append("Each query is executed on 3 LLMs (qwen3.5-9b, deepseek-v4-flash, kimi2.6) and")
    lines.append("graded by deterministic graders (math/coding/ifeval), LLM judge panel 2-of-3")
    lines.append("(planning_agentic), or single judge (creative_synthesis, world_knowledge).")
    lines.append("")
    lines.append("This repo mirrors the routing-level data published at")
    lines.append(
        "[`massaindustries/dataset-A-routing`](https://huggingface.co/datasets/massaindustries/dataset-A-routing),"
    )
    lines.append("here re-laid as **3 configs x 6 dimension splits**.")
    lines.append("")
    lines.append("## Layout")
    lines.append("")
    lines.append("```")
    lines.append("data/")
    for cfg in CONFIGS:
        lines.append(f"  {cfg}/")
        for dim in DIMENSIONS:
            lines.append(f"    {dim}.jsonl.gz")
    lines.append("```")
    lines.append("")
    lines.append("## Usage")
    lines.append("")
    lines.append("```python")
    lines.append("from datasets import load_dataset")
    lines.append("")
    lines.append("# verdict-level per modello (default config)")
    lines.append(f'ds = load_dataset("{REPO_ID}", "results")            # all 6 splits')
    lines.append(f'ds_code = load_dataset("{REPO_ID}", "results", split="coding")')
    lines.append("")
    lines.append("# raw responses + cost + latency + 3x3 judge per planning")
    lines.append(f'ds_v = load_dataset("{REPO_ID}", "verbose", split="planning_agentic")')
    lines.append("")
    lines.append("# prompts + ground truth (replication mode)")
    lines.append(f'ds_e = load_dataset("{REPO_ID}", "evals", split="math_reasoning")')
    lines.append("")
    lines.append("# IMPORTANT: each split file has a `_schema_anchor` row used to lock the")
    lines.append("# pyarrow schema (nullable booleans). Filter it out before use:")
    lines.append('ds = ds.filter(lambda r: r["query_id"] != "_schema_anchor")')
    lines.append("```")
    lines.append("")
    lines.append("## Split sizes (per config, identical across configs)")
    lines.append("")
    lines.append("| split | rows |")
    lines.append("|---|---:|")
    total = 0
    for dim in DIMENSIONS:
        c = by_dim_counts.get(dim, 0)
        total += c
        lines.append(f"| {dim} | {c} |")
    lines.append(f"| **total** | **{total}** |")
    lines.append("")
    lines.append("Note: `planning_agentic_multiturn` (165 rows) is merged into the `planning_agentic` split")
    lines.append("to match the 6-capability framing of the paper.")
    lines.append("")
    lines.append("## Migration from v0.3")
    lines.append("")
    lines.append("Previous revision used 7 configs (`all` + 6 dimensions) with single `train` split.")
    lines.append("New mapping:")
    lines.append("")
    lines.append("| v0.3 (deprecated) | v0.4 (this revision) |")
    lines.append("|---|---|")
    lines.append('| `load_dataset(REPO, "all")` | `load_dataset(REPO, "evals")` then concat splits |')
    lines.append('| `load_dataset(REPO, "coding")` | `load_dataset(REPO, "evals", split="coding")` |')
    lines.append('| (not available) | `load_dataset(REPO, "results")` -- verdict-level |')
    lines.append('| (not available) | `load_dataset(REPO, "verbose")` -- full responses |')
    lines.append("")
    lines.append("## Schema (results)")
    lines.append("")
    lines.append("| field | type | notes |")
    lines.append("|---|---|---|")
    lines.append("| `query_id` | string | `q_NNNNN` (filter `_schema_anchor`) |")
    lines.append("| `query` | string | `<masked>` if gated |")
    lines.append("| `dimension` | string | one of 6 capability dims |")
    lines.append("| `evaluation_protocol_id` | string | grader protocol |")
    lines.append("| `source` | string | original dataset |")
    lines.append("| `gated` | bool | proprietary source (query masked) |")
    lines.append("| `qwen_correct` | bool/null | primary verdict for qwen3.5-9b |")
    lines.append("| `ds4_correct` | bool/null | primary verdict for deepseek-v4-flash |")
    lines.append("| `kimi_correct` | bool/null | primary verdict for kimi2.6 |")
    lines.append("")
    lines.append("`*_correct` is `null` when the judge abstained (~1.4% overall).")
    lines.append("")
    lines.append("## Schema (verbose)")
    lines.append("")
    lines.append("All `results` fields plus per-model m in {qwen, ds4, kimi}:")
    lines.append("`{m}_response`, `{m}_thinking`, `{m}_cost_usd`, `{m}_latency_ms`, `{m}_completion_tokens`,")
    lines.append("`{m}_reasoning_tokens`, `{m}_input_tokens`, `{m}_finish_reason`, `{m}_grader_meta`,")
    lines.append("`{m}_model_id_real`, `{m}_judge_gpt54mini`, `{m}_judge_mistral`, `{m}_judge_glm`.")
    lines.append("")
    lines.append("## Win-rate per model")
    lines.append("")
    lines.append("| model | correct | incorrect | abstention |")
    lines.append("|---|---:|---:|---:|")
    for m in ("qwen", "ds4", "kimi"):
        w = win[m]
        a = abst[m]
        lines.append(f"| {m} | {w['true']} | {w['false']} | {a} |")
    lines.append("")
    lines.append("## License")
    lines.append("")
    lines.append("CC-BY-4.0 (except for queries from gated upstream sources, which keep their original license).")
    lines.append("")
    lines.append("## Citation")
    lines.append("")
    lines.append("Paper: Brick - Calibrated Mixture-of-Models routing (scientificv1).")
    lines.append("Upstream lockfile: see `massaindustries/dataset-A-routing-eval`.")
    return "\n".join(lines) + "\n"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true", help="split + plan, no HF commit")
    args = parser.parse_args()

    src_root = data_dir("final") / "dataset_A_routing"
    out_root = data_dir("final") / "dataset_A_routing_split"

    if out_root.exists():
        shutil.rmtree(out_root)
    out_root.mkdir(parents=True)

    print("=== Phase A: split by dimension ===")
    last_counts: dict[str, int] = {}
    for cfg in CONFIGS:
        src = src_root / cfg / "train.jsonl.gz"
        out_dir = out_root / cfg
        counts = split_config(src, out_dir)
        last_counts = counts
        total = sum(counts.values())
        sizes = {dim: (out_dir / f"{dim}.jsonl.gz").stat().st_size for dim in DIMENSIONS}
        print(f"  {cfg}: {total} rows over {len(DIMENSIONS)} splits")
        for dim in DIMENSIONS:
            print(f"    {dim}: {counts[dim]} rows, {sizes[dim] / 1e6:.2f} MB")

    stats_json = json.loads((src_root / "build_stats.json").read_text())
    readme_text = render_readme(stats_json, last_counts)
    readme_path = out_root / "README.md"
    readme_path.write_text(readme_text, encoding="utf-8")
    print(f"\n  README.md: {len(readme_text)} chars -> {readme_path}")

    build_stats_path = out_root / "build_stats.json"
    shutil.copy(src_root / "build_stats.json", build_stats_path)

    print("\n=== Phase B: HF push plan ===")
    from huggingface_hub import CommitOperationAdd, CommitOperationDelete, HfApi

    api = HfApi(token=hf_token())

    current_files = api.list_repo_files(REPO_ID, repo_type="dataset")
    target_paths = {f"data/{cfg}/{dim}.jsonl.gz" for cfg in CONFIGS for dim in DIMENSIONS}
    keep_paths = target_paths | {"README.md", "build_stats.json", ".gitattributes"}

    delete_paths = [p for p in current_files if p not in keep_paths]

    add_list: list[tuple[Path, str]] = []
    for cfg in CONFIGS:
        for dim in DIMENSIONS:
            add_list.append((out_root / cfg / f"{dim}.jsonl.gz", f"data/{cfg}/{dim}.jsonl.gz"))
    add_list.append((build_stats_path, "build_stats.json"))
    # Sort ASC by size: file piccoli prima, poi grandi (in caso uno fallisca, gli altri sono gia su)
    add_list.sort(key=lambda x: x[0].stat().st_size)
    # README ULTIMO: il viewer attiva il nuovo schema solo dopo i data files
    add_list.append((readme_path, "README.md"))

    print(f"  current files on hub: {len(current_files)}")
    print(f"  to delete: {len(delete_paths)}")
    for p in sorted(delete_paths):
        print(f"    - {p}")
    print(f"  to add: {len(add_list)}")
    for _, remote in add_list:
        print(f"    + {remote}")

    if args.dry_run:
        print("\n[DRY-RUN] no commit performed.")
        return

    # regolo/brick2-dataset-a-eval ha main protetto: commit diretti vietati.
    # Single create_commit con create_pr=True crea UNA PR con tutti i 20 add + 9 delete.
    # Utente review/merge la PR via web UI.
    print(f"\n=== creating PR on {REPO_ID} ===")
    ops: list = [CommitOperationDelete(path_in_repo=p) for p in delete_paths]
    for local, remote in add_list:
        ops.append(CommitOperationAdd(path_or_fileobj=str(local), path_in_repo=remote))

    pr_url = api.create_commit(
        repo_id=REPO_ID,
        repo_type="dataset",
        operations=ops,
        commit_message="v0.4: 3 configs x 6 dimension-splits, 5,504 queries",
        commit_description=(
            "Replaces v0.3 (5,339 queries, 7 configs all+6dim) with v0.4 layout: "
            "3 configs (evals/results/verbose) each split over the 6 capability dimensions. "
            "Source: massaindustries/dataset-A-routing."
        ),
        create_pr=True,
    )
    print(f"\nPR created: {pr_url}")
    print("Review and merge via HF web UI.")


if __name__ == "__main__":
    main()
