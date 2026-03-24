#!/usr/bin/env python3
"""Summarize token usage and costs from brick eval runs.

Reads the brick_usage.jsonl sidecar (written by patch_parse_generations.py)
and optionally correlates with lm-eval results to produce a combined report.

Usage:
    python3 summarize_costs.py --usage stage6/brick_usage.jsonl \
        --results-dir stage6/ --output stage6/cost_summary.json
"""

import argparse
import glob
import json
import os
import sys
from collections import defaultdict
from pathlib import Path

# Pricing table: EUR per 1M tokens
# Keys are normalized model name fragments matched against the API response "model" field
PRICING = {
    "qwen3-8b":            {"input": 0.07, "output": 0.35},
    "gpt-oss-20b":         {"input": 0.10, "output": 0.42},
    "mistral-small":       {"input": 0.50, "output": 2.20},
    "qwen3-coder-next":    {"input": 0.50, "output": 2.00},
    "qwen3.5-122b":        {"input": 1.00, "output": 4.20},
    "llama-3.3-70b":       {"input": 0.60, "output": 2.70},
    "gpt-oss-120b":        {"input": 1.00, "output": 4.20},
}


def normalize_model(raw_model: str) -> str:
    """Extract the core model name from the API response model field.

    Examples:
        'hosted_vllm/openai/gpt-oss-120b' -> 'gpt-oss-120b'
        'gpt-oss-120b'                     -> 'gpt-oss-120b'
    """
    return raw_model.rsplit("/", 1)[-1].strip().lower()


def match_pricing(model_name: str) -> dict | None:
    """Find pricing entry for a model name (case-insensitive substring match)."""
    name = model_name.lower()
    for key, prices in PRICING.items():
        if key in name:
            return prices
    return None


def load_usage(path: str) -> list[dict]:
    records = []
    with open(path) as f:
        for line in f:
            line = line.strip()
            if line:
                records.append(json.loads(line))
    return records


def load_eval_results(results_dir: str) -> dict:
    """Find and load lm-eval results JSON files."""
    results = {}
    for rfile in glob.glob(os.path.join(results_dir, "**/results*.json"), recursive=True):
        try:
            with open(rfile) as f:
                data = json.load(f)
            # Extract benchmark name from path
            parts = Path(rfile).parts
            # Typically: stage6/<benchmark>/brick/results_*.json
            for i, p in enumerate(parts):
                if p == "stage6" and i + 1 < len(parts):
                    bench_name = parts[i + 1]
                    results[bench_name] = data
                    break
        except (json.JSONDecodeError, IndexError):
            continue
    return results


def main():
    parser = argparse.ArgumentParser(description="Summarize brick eval costs")
    parser.add_argument("--usage", required=True, help="Path to brick_usage.jsonl")
    parser.add_argument("--results-dir", required=True, help="Path to stage6/ results dir")
    parser.add_argument("--output", required=True, help="Output JSON path for cost summary")
    args = parser.parse_args()

    if not os.path.exists(args.usage):
        print(f"[WARN] Usage file not found: {args.usage}")
        sys.exit(0)

    records = load_usage(args.usage)
    if not records:
        print("[WARN] No usage records found")
        sys.exit(0)

    # --- Per-model aggregation ---
    model_stats = defaultdict(lambda: {
        "requests": 0,
        "prompt_tokens": 0,
        "completion_tokens": 0,
        "total_tokens": 0,
        "cost_eur": 0.0,
    })

    unknown_models = set()
    total_cost = 0.0
    total_prompt = 0
    total_completion = 0

    for rec in records:
        raw_model = rec.get("model", "unknown")
        model = normalize_model(raw_model)
        prompt_tok = rec.get("prompt_tokens", 0)
        compl_tok = rec.get("completion_tokens", 0)

        stats = model_stats[model]
        stats["requests"] += 1
        stats["prompt_tokens"] += prompt_tok
        stats["completion_tokens"] += compl_tok
        stats["total_tokens"] += rec.get("total_tokens", prompt_tok + compl_tok)

        pricing = match_pricing(model)
        if pricing:
            cost = (prompt_tok * pricing["input"] + compl_tok * pricing["output"]) / 1_000_000
            stats["cost_eur"] += cost
            total_cost += cost
        else:
            unknown_models.add(model)

        total_prompt += prompt_tok
        total_completion += compl_tok

    # --- Load eval results ---
    eval_results = load_eval_results(args.results_dir)

    # --- Build summary ---
    summary = {
        "total": {
            "requests": len(records),
            "prompt_tokens": total_prompt,
            "completion_tokens": total_completion,
            "total_tokens": total_prompt + total_completion,
            "cost_eur": round(total_cost, 6),
        },
        "per_model": {},
        "eval_results": {},
    }

    for model, stats in sorted(model_stats.items()):
        pricing = match_pricing(model)
        summary["per_model"][model] = {
            "requests": stats["requests"],
            "prompt_tokens": stats["prompt_tokens"],
            "completion_tokens": stats["completion_tokens"],
            "total_tokens": stats["total_tokens"],
            "cost_eur": round(stats["cost_eur"], 6),
            "pricing_eur_per_1m": pricing if pricing else "UNKNOWN",
        }

    # Extract key metrics from eval results
    for bench_name, data in eval_results.items():
        bench_results = {}
        if "results" in data:
            for task_key, metrics in data["results"].items():
                bench_results[task_key] = {
                    k: v for k, v in metrics.items()
                    if isinstance(v, (int, float)) and not k.startswith("_")
                }
        summary["eval_results"][bench_name] = bench_results

    if unknown_models:
        summary["warnings"] = [f"Unknown pricing for model(s): {', '.join(sorted(unknown_models))}"]

    # --- Write output ---
    os.makedirs(os.path.dirname(args.output) or ".", exist_ok=True)
    with open(args.output, "w") as f:
        json.dump(summary, f, indent=2, ensure_ascii=False)

    # --- Print human-readable summary ---
    print("\n" + "=" * 70)
    print("  BRICK EVAL — TOKEN & COST SUMMARY")
    print("=" * 70)
    print(f"  Total requests:         {len(records)}")
    print(f"  Total prompt tokens:    {total_prompt:,}")
    print(f"  Total completion tokens: {total_completion:,}")
    print(f"  Total tokens:           {total_prompt + total_completion:,}")
    print(f"  Total cost:             €{total_cost:.4f}")
    print("-" * 70)
    print(f"  {'Model':<30} {'Reqs':>6} {'Prompt':>10} {'Compl':>10} {'Cost €':>10}")
    print("-" * 70)
    for model, stats in sorted(model_stats.items(), key=lambda x: -x[1]["cost_eur"]):
        print(f"  {model:<30} {stats['requests']:>6} {stats['prompt_tokens']:>10,} {stats['completion_tokens']:>10,} {stats['cost_eur']:>10.4f}")
    print("=" * 70)

    if unknown_models:
        print(f"\n  [WARN] Unknown pricing for: {', '.join(sorted(unknown_models))}")

    print(f"\n  Full report: {args.output}")


if __name__ == "__main__":
    main()
