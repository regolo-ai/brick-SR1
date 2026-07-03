#!/usr/bin/env python3
"""Estrae i profili skill 6D dei modelli dal subset HF `results`.

Input primario:
  massaindustries/dataset-A-routing, config `results`, split `train`

Output:
  data/reports/model_skill_profiles.json
  data/reports/model_skill_profiles.md

La stima skill e una accuracy bayesiana smoothed:
  a_m,c = (K_m,c + k * mu_c) / (N_m,c + k)

dove K_m,c sono le risposte corrette del modello m nella capability c,
N_m,c e il supporto totale, mu_c e la prior globale della capability,
e k e la forza della prior.
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from collections import Counter
from collections.abc import Iterable
from pathlib import Path

import pyarrow as pa
import pyarrow.ipc as pa_ipc

REPO = Path(__file__).resolve().parents[1]

DATASET_ID = "massaindustries/dataset-A-routing"
DATASET_CONFIG = "results"
DATASET_SPLIT = "train"

CAPABILITIES = [
    "coding",
    "creative_synthesis",
    "instruction_following",
    "math_reasoning",
    "planning_agentic",
    "world_knowledge",
]

DIMENSION_ALIASES = {
    "planning_agentic_multiturn": "planning_agentic",
}

MODEL_COLUMNS = {
    "qwen3.5-9b": "qwen_correct",
    "deepseek-v4-flash": "ds4_correct",
    "kimi2.6": "kimi_correct",
}

DEFAULT_CACHE_ROOT = Path.home() / ".cache" / "huggingface" / "datasets"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--prior-strength", type=float, default=8.0)
    parser.add_argument(
        "--json-out",
        type=Path,
        default=REPO / "data" / "reports" / "model_skill_profiles.json",
    )
    parser.add_argument(
        "--md-out",
        type=Path,
        default=REPO / "data" / "reports" / "model_skill_profiles.md",
    )
    parser.add_argument(
        "--cache-root",
        type=Path,
        default=DEFAULT_CACHE_ROOT,
        help="Root Hugging Face datasets cache used for Arrow fallback.",
    )
    return parser.parse_args()


def load_hf_rows() -> Iterable[dict]:
    """Load rows via datasets when possible."""
    from datasets import load_dataset

    return load_dataset(DATASET_ID, DATASET_CONFIG, split=DATASET_SPLIT)


def latest_cached_arrow(cache_root: Path) -> Path | None:
    base = cache_root / "massaindustries___dataset-a-routing" / DATASET_CONFIG / "0.0.0"
    if not base.exists():
        return None

    candidates = []
    for arrow_path in base.glob("*/dataset-a-routing-train.arrow"):
        info_path = arrow_path.with_name("dataset_info.json")
        if not info_path.exists():
            continue
        mtime = max(arrow_path.stat().st_mtime, info_path.stat().st_mtime)
        candidates.append((mtime, arrow_path))
    if not candidates:
        return None
    return sorted(candidates)[-1][1]


def read_arrow_table(path: Path) -> pa.Table:
    with path.open("rb") as f:
        try:
            reader = pa_ipc.open_stream(f)
            return reader.read_all()
        except pa.ArrowInvalid:
            f.seek(0)
            reader = pa_ipc.open_file(f)
            return reader.read_all()


def iter_cached_arrow_rows(cache_root: Path) -> Iterable[dict]:
    arrow_path = latest_cached_arrow(cache_root)
    if arrow_path is None:
        raise FileNotFoundError("cached Arrow file not found for " f"{DATASET_ID}/{DATASET_CONFIG}/{DATASET_SPLIT}")

    table = read_arrow_table(arrow_path)
    for batch in table.to_batches(max_chunksize=8192):
        names = batch.schema.names
        cols = [batch.column(i).to_pylist() for i in range(len(names))]
        for values in zip(*cols, strict=False):
            yield dict(zip(names, values, strict=False))


def iter_rows(cache_root: Path) -> tuple[str, Iterable[dict]]:
    """Return source label and row iterator.

    The datasets loader can fail in restricted environments because it creates
    lock files under the HF cache. In that case we read the cached Arrow file
    directly, which is deterministic for this published subset.
    """
    try:
        return "huggingface_datasets", load_hf_rows()
    except Exception as exc:
        print(f"[warn] datasets loader unavailable, using Arrow cache: {exc}", file=sys.stderr)
        return "cached_arrow", iter_cached_arrow_rows(cache_root)


def bool_correct(value: object) -> bool:
    return value is True


def aggregate(rows: Iterable[dict]) -> tuple[dict, dict, int, Counter]:
    correct: dict[str, Counter] = {model: Counter() for model in MODEL_COLUMNS}
    support: dict[str, Counter] = {model: Counter() for model in MODEL_COLUMNS}
    dimensions = Counter()
    total_rows = 0

    for row in rows:
        total_rows += 1
        raw_dim = row.get("dimension")
        dim = DIMENSION_ALIASES.get(raw_dim, raw_dim)
        if dim not in CAPABILITIES:
            raise ValueError(f"unknown dimension {raw_dim!r} at row {total_rows}")
        dimensions[dim] += 1

        for model, column in MODEL_COLUMNS.items():
            support[model][dim] += 1
            if bool_correct(row.get(column)):
                correct[model][dim] += 1

    return correct, support, total_rows, dimensions


def compute_profiles(correct: dict, support: dict, prior_strength: float) -> dict:
    global_correct = Counter()
    global_support = Counter()
    for model in MODEL_COLUMNS:
        for cap in CAPABILITIES:
            global_correct[cap] += correct[model][cap]
            global_support[cap] += support[model][cap]

    priors = {}
    for cap in CAPABILITIES:
        if global_support[cap] == 0:
            raise ValueError(f"no support for capability {cap!r}")
        priors[cap] = global_correct[cap] / global_support[cap]

    models = {}
    for model in MODEL_COLUMNS:
        ability = {}
        stderr = {}
        raw_accuracy = {}
        for cap in CAPABILITIES:
            k = correct[model][cap]
            n = support[model][cap]
            if n == 0:
                score = priors[cap]
                raw = None
            else:
                raw = k / n
                score = (k + prior_strength * priors[cap]) / (n + prior_strength)
            ability[cap] = round(score, 6)
            raw_accuracy[cap] = None if raw is None else round(raw, 6)
            stderr[cap] = round(math.sqrt(score * (1.0 - score) / (n + prior_strength + 1)), 6)

        models[model] = {
            "ability": ability,
            "ability_vector": [ability[cap] for cap in CAPABILITIES],
            "correct": {cap: int(correct[model][cap]) for cap in CAPABILITIES},
            "support": {cap: int(support[model][cap]) for cap in CAPABILITIES},
            "raw_accuracy": raw_accuracy,
            "stderr": stderr,
        }

    return {
        "global_prior": {cap: round(priors[cap], 6) for cap in CAPABILITIES},
        "models": models,
    }


def write_json(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, sort_keys=False) + "\n", encoding="utf-8")


def fmt_float(value: float) -> str:
    return f"{value:.4f}"


def write_markdown(path: Path, payload: dict) -> None:
    lines = [
        "# Model Skill Profiles 6D",
        "",
        "Profili skill estratti dal subset `results` di `massaindustries/dataset-A-routing`.",
        "",
        "Formula:",
        "",
        "```text",
        "a_m,c = (K_m,c + k * mu_c) / (N_m,c + k)",
        "```",
        "",
        f"`k = {payload['formula']['prior_strength']}`. I valori null/missing contano come non corretti.",
        "",
        "Dimension aliases:",
        "",
        "```json",
        json.dumps(payload.get("dimension_aliases", {}), indent=2, sort_keys=True),
        "```",
        "",
        "Capability order:",
        "",
        "```text",
        "\n".join(payload["capabilities"]),
        "```",
        "",
        "## Skill Vector",
        "",
        "| Model | " + " | ".join(payload["capabilities"]) + " |",
        "|---|" + "|".join(["---:"] * len(payload["capabilities"])) + "|",
    ]

    for model, profile in payload["models"].items():
        vals = [fmt_float(profile["ability"][cap]) for cap in payload["capabilities"]]
        lines.append(f"| {model} | " + " | ".join(vals) + " |")

    lines.extend(
        [
            "",
            "## Correct / Support",
            "",
            "| Model | " + " | ".join(payload["capabilities"]) + " |",
            "|---|" + "|".join(["---:"] * len(payload["capabilities"])) + "|",
        ]
    )

    for model, profile in payload["models"].items():
        vals = [f"{profile['correct'][cap]}/{profile['support'][cap]}" for cap in payload["capabilities"]]
        lines.append(f"| {model} | " + " | ".join(vals) + " |")

    lines.extend(
        [
            "",
            "## Ranking Per Capability",
            "",
        ]
    )

    for cap in payload["capabilities"]:
        ranked = sorted(
            payload["models"].items(),
            key=lambda item: item[1]["ability"][cap],
            reverse=True,
        )
        lines.append(f"### {cap}")
        lines.append("")
        lines.append("| Rank | Model | Skill | Raw accuracy | Support |")
        lines.append("|---:|---|---:|---:|---:|")
        for idx, (model, profile) in enumerate(ranked, start=1):
            raw = profile["raw_accuracy"][cap]
            raw_txt = "n/a" if raw is None else fmt_float(raw)
            lines.append(
                f"| {idx} | {model} | {fmt_float(profile['ability'][cap])} | "
                f"{raw_txt} | {profile['support'][cap]} |"
            )
        lines.append("")

    lines.extend(
        [
            "## Global Priors",
            "",
            "| Capability | Prior mu_c |",
            "|---|---:|",
        ]
    )
    for cap in payload["capabilities"]:
        lines.append(f"| {cap} | {fmt_float(payload['global_prior'][cap])} |")

    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def main() -> int:
    args = parse_args()
    source_kind, rows = iter_rows(args.cache_root)
    correct, support, total_rows, dimensions = aggregate(rows)
    computed = compute_profiles(correct, support, args.prior_strength)

    payload = {
        "version": 1,
        "source": {
            "dataset": DATASET_ID,
            "config": DATASET_CONFIG,
            "split": DATASET_SPLIT,
            "loader": source_kind,
            "num_rows": total_rows,
        },
        "formula": {
            "estimator": "bayesian_smoothed_accuracy",
            "prior_strength": args.prior_strength,
            "none_missing_policy": "count_as_incorrect",
        },
        "dimension_aliases": DIMENSION_ALIASES,
        "capabilities": CAPABILITIES,
        "dimension_support": {cap: int(dimensions[cap]) for cap in CAPABILITIES},
        "global_prior": computed["global_prior"],
        "models": computed["models"],
    }

    write_json(args.json_out, payload)
    write_markdown(args.md_out, payload)

    print(f"[read] {DATASET_ID}/{DATASET_CONFIG}/{DATASET_SPLIT}: {total_rows} rows via {source_kind}")
    print(f"[write] {args.json_out}")
    print(f"[write] {args.md_out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
