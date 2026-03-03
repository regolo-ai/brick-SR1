#!/usr/bin/env python3
"""Eval Cost & Token Usage Report Generator.

Counts tokens from evaluation sample files using HuggingFace tokenizers,
calculates costs based on per-model pricing, and generates comparative reports.
"""

import json
import sys
from dataclasses import dataclass
from pathlib import Path

import pandas as pd
from transformers import AutoTokenizer

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

# HuggingFace tokenizer for each model short name
TOKENIZER_MAP: dict[str, str] = {
    "brick": "meta-llama/Llama-3.3-70B-Instruct",
    "llama70b": "meta-llama/Llama-3.3-70B-Instruct",
    "gptoss120b": "Qwen/QwQ-32B",
    "gptoss20b": "Qwen/Qwen3-32B",
    "mistral32": "mistralai/Mistral-Small-3.1-24B-Instruct-2503",
    "qwen3coder": "Qwen/Qwen3-235B-A22B",
    "qwen3_8b": "Qwen/Qwen3-8B",
}

# Primary metric for each benchmark: (task_key_in_results_json, metric_key)
PRIMARY_METRICS: dict[str, tuple[str, str]] = {
    "arc_challenge": ("arc_challenge_chat", "exact_match,remove_whitespace"),
    "bbh": ("bbh_cot_zeroshot", "exact_match,flexible-extract"),
    "drop": ("drop", "f1,none"),
    "humaneval": ("humaneval_instruct", "pass@1,create_test"),
    "ifeval": ("ifeval", "prompt_level_strict_acc,none"),
    "mbpp": ("mbpp", "pass_at_1,none"),
    "minerva_math": ("minerva_math", "math_verify,none"),
    "mmlu_pro": ("mmlu_pro", "exact_match,custom-extract"),
    "truthfulqa": ("truthfulqa_gen", "rouge1_acc,none"),
}

# ---------------------------------------------------------------------------
# Data classes
# ---------------------------------------------------------------------------


@dataclass
class EvalRun:
    """One evaluation run: a (benchmark, model) pair with its result files."""

    benchmark: str
    model_short: str
    results_path: Path
    sample_paths: list[Path]


@dataclass
class TokenCounts:
    """Aggregated token counts for an evaluation run."""

    input_tokens: int = 0
    output_tokens: int = 0
    num_samples: int = 0


# ---------------------------------------------------------------------------
# Loading helpers
# ---------------------------------------------------------------------------


def load_pricing(path: Path) -> dict:
    with open(path) as f:
        return json.load(f)


def discover_eval_results(base_dir: Path) -> list[EvalRun]:
    """Walk stage2/ directory tree and collect completed eval runs."""
    runs: list[EvalRun] = []
    if not base_dir.exists():
        return runs
    for bench_dir in sorted(base_dir.iterdir()):
        if not bench_dir.is_dir() or bench_dir.name == "logs":
            continue
        benchmark = bench_dir.name
        for model_dir in sorted(bench_dir.iterdir()):
            if not model_dir.is_dir():
                continue
            model_short = model_dir.name
            # Inner directory contains the actual files (named after model)
            for inner_dir in model_dir.iterdir():
                if not inner_dir.is_dir():
                    continue
                results_files = sorted(inner_dir.glob("results_*.json"))
                sample_files = sorted(inner_dir.glob("samples_*.jsonl"))
                if results_files and sample_files:
                    runs.append(
                        EvalRun(
                            benchmark=benchmark,
                            model_short=model_short,
                            results_path=results_files[-1],  # latest
                            sample_paths=sample_files,
                        )
                    )
    return runs


def load_tokenizers(model_names: set[str]) -> dict[str, AutoTokenizer]:
    """Load one HuggingFace tokenizer per unique model, with caching."""
    tokenizers: dict[str, AutoTokenizer] = {}
    loaded_hf: dict[str, AutoTokenizer] = {}
    for model_short in sorted(model_names):
        hf_name = TOKENIZER_MAP.get(model_short)
        if hf_name is None:
            print(
                f"  Warning: no tokenizer mapping for '{model_short}', skipping",
                file=sys.stderr,
            )
            continue
        if hf_name not in loaded_hf:
            print(f"  Loading tokenizer: {hf_name}", file=sys.stderr)
            try:
                loaded_hf[hf_name] = AutoTokenizer.from_pretrained(
                    hf_name, trust_remote_code=True
                )
            except Exception as e:
                print(f"  Error loading {hf_name}: {e}", file=sys.stderr)
                continue
        tokenizers[model_short] = loaded_hf[hf_name]
    return tokenizers


# ---------------------------------------------------------------------------
# Token counting
# ---------------------------------------------------------------------------


def count_tokens(sample_paths: list[Path], tokenizer: AutoTokenizer) -> TokenCounts:
    """Tokenize prompts and responses across all sample JSONL files."""
    counts = TokenCounts()
    for path in sample_paths:
        with open(path) as f:
            for line in f:
                if not line.strip():
                    continue
                sample = json.loads(line)
                counts.num_samples += 1

                # --- Input tokens ---
                try:
                    arg0 = sample["arguments"]["gen_args_0"]["arg_0"]
                    messages_str = arg0[0] if isinstance(arg0, list) else arg0
                    messages = json.loads(messages_str)
                    # Keep only role/content (strip 'type' and others)
                    clean_msgs = [
                        {"role": m["role"], "content": m["content"]} for m in messages
                    ]
                    try:
                        result = tokenizer.apply_chat_template(
                            clean_msgs, tokenize=True, add_generation_prompt=True
                        )
                        # transformers >=5 returns BatchEncoding; extract input_ids
                        if hasattr(result, "input_ids"):
                            token_ids = result["input_ids"]
                        elif isinstance(result, list):
                            token_ids = result
                        else:
                            token_ids = result["input_ids"]
                        counts.input_tokens += len(token_ids)
                    except Exception:
                        # Fallback: concatenate all content and tokenize as plain text
                        text = "\n".join(m.get("content", "") for m in messages)
                        counts.input_tokens += len(tokenizer.encode(text))
                except Exception:
                    pass

                # --- Output tokens ---
                try:
                    resp_text = sample["resps"][0][0]
                    counts.output_tokens += len(tokenizer.encode(resp_text))
                except Exception:
                    pass

    return counts


# ---------------------------------------------------------------------------
# Metric extraction & cost calculation
# ---------------------------------------------------------------------------


def extract_performance(
    results_path: Path, benchmark: str
) -> tuple[str, float | None]:
    """Return (metric_name, score) from a results JSON."""
    with open(results_path) as f:
        data = json.load(f)
    entry = PRIMARY_METRICS.get(benchmark)
    if entry is None:
        return ("unknown", None)
    task_key, metric_key = entry
    all_results = data.get("results", {})
    # Try primary task key, then fall back to any key containing the metric
    results = all_results.get(task_key, {})
    score = results.get(metric_key)
    if score is None:
        for tk, tv in all_results.items():
            if metric_key in tv:
                score = tv[metric_key]
                break
    return (metric_key, score)


def calculate_cost(
    tokens: TokenCounts, model_pricing: dict
) -> tuple[float | None, float | None, float | None]:
    """Return (input_cost, output_cost, total_cost) in EUR, or None if price unknown."""
    input_price = model_pricing.get("input_per_1M")
    output_price = model_pricing.get("output_per_1M")
    if input_price is None or output_price is None:
        return (None, None, None)
    input_cost = tokens.input_tokens * input_price / 1_000_000
    output_cost = tokens.output_tokens * output_price / 1_000_000
    return (input_cost, output_cost, input_cost + output_cost)


# ---------------------------------------------------------------------------
# Formatting helpers
# ---------------------------------------------------------------------------


def _fmt_tok(n: int) -> str:
    return f"{n:,}"


def _fmt_cost(c: float | None) -> str:
    if c is None or (isinstance(c, float) and c != c):  # None or NaN
        return "—"
    if c < 0.01:
        return f"\u20ac{c:.4f}"
    return f"\u20ac{c:.2f}"


def _fmt_score(s: float | None) -> str:
    if s is None or (isinstance(s, float) and s != s):  # None or NaN
        return "—"
    return f"{s * 100:.1f}%"


# ---------------------------------------------------------------------------
# Report generation
# ---------------------------------------------------------------------------


def generate_markdown_report(df: pd.DataFrame, pricing: dict) -> str:
    lines: list[str] = []
    lines.append("# Eval Cost & Token Usage Report\n")

    # ── Riepilogo Generale ──────────────────────────────────────────────
    lines.append("## Riepilogo Generale\n")
    lines.append(
        "| Modello | Benchmark | Score | Samples "
        "| Input Tok | Output Tok | Costo Tot |"
    )
    lines.append(
        "|---------|-----------|-------|---------|-----------|------------|-----------|"
    )
    for _, row in df.sort_values(["benchmark", "display_name"]).iterrows():
        lines.append(
            f"| {row['display_name']} | {row['benchmark']} "
            f"| {_fmt_score(row['score'])} | {row['num_samples']:,} "
            f"| {_fmt_tok(row['input_tokens'])} | {_fmt_tok(row['output_tokens'])} "
            f"| {_fmt_cost(row['total_cost_eur'])} |"
        )
    lines.append("")

    # ── Per-Benchmark Detail ────────────────────────────────────────────
    lines.append("## Per-Benchmark Detail\n")
    for bench in sorted(df["benchmark"].unique()):
        bench_df = df[df["benchmark"] == bench].sort_values("display_name")
        metric_name = bench_df.iloc[0]["metric_name"]
        lines.append(f"### {bench} (`{metric_name}`)\n")
        lines.append(
            "| Modello | Score | Samples | Avg In Tok | Avg Out Tok "
            "| Totale Tok | Costo (\u20ac) |"
        )
        lines.append(
            "|---------|-------|---------|------------|-------------|"
            "------------|-----------|"
        )
        for _, row in bench_df.iterrows():
            n = max(row["num_samples"], 1)
            avg_in = row["input_tokens"] // n
            avg_out = row["output_tokens"] // n
            lines.append(
                f"| {row['display_name']} | {_fmt_score(row['score'])} | {n:,} "
                f"| {_fmt_tok(avg_in)} | {_fmt_tok(avg_out)} "
                f"| {_fmt_tok(row['total_tokens'])} | {_fmt_cost(row['total_cost_eur'])} |"
            )
        lines.append("")

    # ── Confronto con Brick ─────────────────────────────────────────────
    brick_df = df[df["model"] == "brick"]
    non_brick_df = df[df["model"] != "brick"]

    if not brick_df.empty:
        lines.append("## Confronto con Brick\n")
        lines.append(
            "| Benchmark | Brick Score | Miglior Modello | Suo Score "
            "| Delta | Costo Modello |"
        )
        lines.append(
            "|-----------|-------------|-----------------|-----------|"
            "-------|---------------|"
        )
        for _, brick_row in brick_df.iterrows():
            bench = brick_row["benchmark"]
            others = non_brick_df[non_brick_df["benchmark"] == bench]
            valid = others.dropna(subset=["score"])
            if valid.empty:
                continue
            best = valid.loc[valid["score"].idxmax()]
            if brick_row["score"] is not None and best["score"] is not None:
                delta = best["score"] - brick_row["score"]
                delta_str = f"{delta * 100:+.1f}pp"
            else:
                delta_str = "—"
            lines.append(
                f"| {bench} | {_fmt_score(brick_row['score'])} "
                f"| {best['display_name']} | {_fmt_score(best['score'])} "
                f"| {delta_str} | {_fmt_cost(best['total_cost_eur'])} |"
            )
        lines.append("")

    # ── Stima Range Costo Brick ─────────────────────────────────────────
    if not brick_df.empty:
        lines.append("## Stima Range Costo Brick\n")
        lines.append(
            "> Il costo reale di Brick dipende dalla distribuzione del routing "
            "tra i modelli.\n"
        )
        lines.append(
            "> I range seguenti mostrano il costo se **tutte** le request "
            "fossero inoltrate al modello più/meno economico.\n"
        )
        lines.append(
            "| Benchmark | Brick Tokens | Se cheapest | Se costliest "
            "| Modello cheap | Modello costly |"
        )
        lines.append(
            "|-----------|-------------|-------------|--------------|"
            "---------------|----------------|"
        )
        # Models with actual prices
        priced = {
            k: v
            for k, v in pricing["models"].items()
            if v.get("input_per_1M") is not None and v.get("output_per_1M") is not None
        }
        for _, brick_row in brick_df.iterrows():
            in_tok = brick_row["input_tokens"]
            out_tok = brick_row["output_tokens"]
            total_tok = brick_row["total_tokens"]
            costs = {}
            for mk, mp in priced.items():
                costs[mk] = (
                    in_tok * mp["input_per_1M"] / 1_000_000
                    + out_tok * mp["output_per_1M"] / 1_000_000
                )
            if not costs:
                continue
            cheap = min(costs, key=costs.get)
            costly = max(costs, key=costs.get)
            lines.append(
                f"| {brick_row['benchmark']} | {_fmt_tok(total_tok)} "
                f"| {_fmt_cost(costs[cheap])} | {_fmt_cost(costs[costly])} "
                f"| {priced[cheap]['display_name']} "
                f"| {priced[costly]['display_name']} |"
            )
        lines.append("")

    lines.append("---\n*Report generated by `cost_report.py`*\n")
    return "\n".join(lines)


def generate_csv(df: pd.DataFrame, output_path: Path) -> None:
    df.to_csv(output_path, index=False)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def main() -> None:
    script_dir = Path(__file__).parent
    pricing_path = script_dir / "pricing.json"
    if not pricing_path.exists():
        print(f"Error: {pricing_path} not found", file=sys.stderr)
        sys.exit(1)

    pricing = load_pricing(pricing_path)

    print("Discovering evaluation results...", file=sys.stderr)
    runs = discover_eval_results(script_dir / "stage2")
    print(f"Found {len(runs)} evaluation runs", file=sys.stderr)

    # Keep only models we have a tokenizer mapping for
    known = set(TOKENIZER_MAP)
    runs = [r for r in runs if r.model_short in known]
    print(f"Processing {len(runs)} runs (known models only)", file=sys.stderr)

    model_names = {r.model_short for r in runs}
    print(f"\nLoading tokenizers for {len(model_names)} models...", file=sys.stderr)
    tokenizers = load_tokenizers(model_names)

    results: list[dict] = []
    for i, run in enumerate(runs, 1):
        print(
            f"[{i}/{len(runs)}] {run.benchmark}/{run.model_short}...",
            file=sys.stderr,
        )
        tokenizer = tokenizers.get(run.model_short)
        if tokenizer is None:
            print("  Skipping (no tokenizer available)", file=sys.stderr)
            continue

        tokens = count_tokens(run.sample_paths, tokenizer)
        metric_name, score = extract_performance(run.results_path, run.benchmark)
        model_pricing = pricing["models"].get(run.model_short, {})
        input_cost, output_cost, total_cost = calculate_cost(tokens, model_pricing)
        display_name = model_pricing.get("display_name", run.model_short)

        results.append(
            {
                "benchmark": run.benchmark,
                "model": run.model_short,
                "display_name": display_name,
                "metric_name": metric_name,
                "score": score,
                "num_samples": tokens.num_samples,
                "input_tokens": tokens.input_tokens,
                "output_tokens": tokens.output_tokens,
                "total_tokens": tokens.input_tokens + tokens.output_tokens,
                "input_cost_eur": input_cost,
                "output_cost_eur": output_cost,
                "total_cost_eur": total_cost,
            }
        )

    if not results:
        print("No results to report!", file=sys.stderr)
        sys.exit(1)

    df = pd.DataFrame(results)

    md = generate_markdown_report(df, pricing)
    md_path = script_dir / "cost_report.md"
    md_path.write_text(md)
    print(f"\nMarkdown report: {md_path}", file=sys.stderr)

    csv_path = script_dir / "cost_report.csv"
    generate_csv(df, csv_path)
    print(f"CSV data: {csv_path}", file=sys.stderr)

    print("\nDone!", file=sys.stderr)


if __name__ == "__main__":
    main()
