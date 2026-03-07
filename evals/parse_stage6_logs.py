#!/usr/bin/env python3
"""Parse stage6 Docker logs to produce a per-benchmark x model cost summary.

Input:
  - stage6/docker_logs/*.jsonl — Docker logs tagged with benchmark name
  - evals/pricing.json — EUR prices per model

Output:
  - stage6/stage6_cost_summary.csv — breakdown per benchmark x routed model

Usage:
    python3 evals/parse_stage6_logs.py
    python3 evals/parse_stage6_logs.py --docker-logs-dir evals/stage6/docker_logs
"""

import argparse
import csv
import json
import os
import re
import sys
from collections import defaultdict
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
DEFAULT_DOCKER_LOGS_DIR = SCRIPT_DIR / "stage6" / "docker_logs"
DEFAULT_PRICING_FILE = SCRIPT_DIR / "pricing.json"
DEFAULT_OUTPUT_FILE = SCRIPT_DIR / "stage6" / "stage6_cost_summary.csv"

# Model name normalization: map various log representations to pricing.json keys
MODEL_NAME_MAP = {
    "llama-3.3-70b-instruct": "llama70b",
    "llama-3.3-70b": "llama70b",
    "llama70b": "llama70b",
    "gpt-oss-120b": "gptoss120b",
    "gptoss120b": "gptoss120b",
    "gpt-oss-20b": "gptoss20b",
    "gptoss20b": "gptoss20b",
    "mistral-small3.2": "mistral32",
    "mistral-small-3.2": "mistral32",
    "mistral32": "mistral32",
    "qwen3-coder-next": "qwen3coder",
    "qwen3coder": "qwen3coder",
    "qwen3-8b": "qwen3_8b",
    "qwen3_8b": "qwen3_8b",
    "qwen3-vl-32b": "qwen3vl32b",
    "qwen3vl32b": "qwen3vl32b",
    "gemma-3-27b-it": "gemma27b",
}


def normalize_model_name(name: str) -> str:
    """Normalize a model name from logs to a pricing.json key."""
    key = name.strip().lower()
    return MODEL_NAME_MAP.get(key, key)


def load_pricing(pricing_path: Path) -> dict:
    """Load pricing.json and return {normalized_key: {input_per_1M, output_per_1M}}."""
    with open(pricing_path) as f:
        data = json.load(f)
    pricing = {}
    for key, info in data["models"].items():
        if info.get("input_per_1M") is not None:
            pricing[key] = {
                "display_name": info["display_name"],
                "input_per_1M": float(info["input_per_1M"]),
                "output_per_1M": float(info["output_per_1M"]),
            }
    return pricing


def extract_model_and_tokens(obj: dict) -> tuple:
    """Extract (model_name, prompt_tokens, completion_tokens) from a log entry.

    Looks for common patterns in structured logs:
    - Direct fields: model, prompt_tokens, completion_tokens
    - Nested usage: usage.prompt_tokens, usage.completion_tokens
    - Log message patterns with model routing info
    """
    model = None
    prompt_tokens = 0
    completion_tokens = 0

    # Pattern 1: Direct fields (common in request/response logs)
    if "model" in obj:
        model = obj["model"]

    # Pattern 2: Routed model field
    if "routed_model" in obj:
        model = obj["routed_model"]
    if "selected_model" in obj:
        model = obj["selected_model"]

    # Pattern 3: Usage object
    usage = obj.get("usage", {})
    if isinstance(usage, dict):
        prompt_tokens = usage.get("prompt_tokens", 0) or 0
        completion_tokens = usage.get("completion_tokens", 0) or 0

    # Pattern 4: Top-level token counts
    if not prompt_tokens:
        prompt_tokens = obj.get("prompt_tokens", 0) or 0
    if not completion_tokens:
        completion_tokens = obj.get("completion_tokens", 0) or 0

    # Pattern 5: msg field with structured info
    msg = obj.get("msg", "")
    if isinstance(msg, str) and not model:
        # Try to extract model from log messages like "routed to gpt-oss-120b"
        m = re.search(r'(?:routed|routing|model|selected)[:\s]+["\']?([a-zA-Z0-9._-]+)', msg, re.I)
        if m:
            model = m.group(1)

    # Pattern 6: Look in nested response/choices structure
    if "choices" in obj and isinstance(obj["choices"], list):
        # This is an API response
        pass

    return model, int(prompt_tokens), int(completion_tokens)


def parse_jsonl_files(docker_logs_dir: Path) -> list:
    """Parse all per-benchmark JSONL files. Returns list of (benchmark, model, prompt_tok, compl_tok)."""
    records = []

    for jsonl_file in sorted(docker_logs_dir.glob("*.jsonl")):
        # Skip the combined file
        if jsonl_file.name == "all_benchmarks_combined.jsonl":
            continue

        benchmark = jsonl_file.stem  # e.g., "mmlu_pro" from "mmlu_pro.jsonl"

        with open(jsonl_file, errors="replace") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    obj = json.loads(line)
                except json.JSONDecodeError:
                    continue

                # Override benchmark from the tagged field if present
                bm = obj.get("benchmark", benchmark)

                model, prompt_tok, compl_tok = extract_model_and_tokens(obj)

                if model and (prompt_tok > 0 or compl_tok > 0):
                    records.append((bm, model, prompt_tok, compl_tok))

    return records


def aggregate_and_cost(records: list, pricing: dict) -> list:
    """Aggregate records by (benchmark, model) and compute costs.

    Returns list of dicts for CSV output.
    """
    # Aggregate: (benchmark, normalized_model) -> {requests, prompt_tok, compl_tok}
    agg = defaultdict(lambda: {"requests": 0, "prompt_tokens": 0, "completion_tokens": 0})

    for benchmark, model, prompt_tok, compl_tok in records:
        norm = normalize_model_name(model)
        key = (benchmark, norm)
        agg[key]["requests"] += 1
        agg[key]["prompt_tokens"] += prompt_tok
        agg[key]["completion_tokens"] += compl_tok

    # Compute costs
    rows = []
    for (benchmark, model_key), stats in sorted(agg.items()):
        price = pricing.get(model_key)
        if price:
            input_cost = stats["prompt_tokens"] / 1_000_000 * price["input_per_1M"]
            output_cost = stats["completion_tokens"] / 1_000_000 * price["output_per_1M"]
            display = price["display_name"]
        else:
            input_cost = 0.0
            output_cost = 0.0
            display = model_key

        rows.append({
            "benchmark": benchmark,
            "model": display,
            "model_key": model_key,
            "requests": stats["requests"],
            "prompt_tokens": stats["prompt_tokens"],
            "completion_tokens": stats["completion_tokens"],
            "input_cost_eur": round(input_cost, 4),
            "output_cost_eur": round(output_cost, 4),
            "total_cost_eur": round(input_cost + output_cost, 4),
        })

    return rows


def write_csv(rows: list, output_path: Path):
    """Write aggregated rows to CSV."""
    if not rows:
        print("WARNING: No data to write — no model/token records found in logs.")
        return

    fieldnames = [
        "benchmark", "model", "model_key", "requests",
        "prompt_tokens", "completion_tokens",
        "input_cost_eur", "output_cost_eur", "total_cost_eur",
    ]

    output_path.parent.mkdir(parents=True, exist_ok=True)
    with open(output_path, "w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)

    # Print summary
    total_cost = sum(r["total_cost_eur"] for r in rows)
    total_requests = sum(r["requests"] for r in rows)
    print(f"\nCost summary written to {output_path}")
    print(f"  Total requests with token data: {total_requests}")
    print(f"  Total cost: EUR {total_cost:.4f}")

    # Per-model summary
    model_totals = defaultdict(float)
    model_requests = defaultdict(int)
    for r in rows:
        model_totals[r["model"]] += r["total_cost_eur"]
        model_requests[r["model"]] += r["requests"]

    print("\n  Per-model breakdown:")
    for model in sorted(model_totals, key=lambda m: model_totals[m], reverse=True):
        pct = model_totals[model] / total_cost * 100 if total_cost > 0 else 0
        print(f"    {model:30s}  {model_requests[model]:5d} reqs  EUR {model_totals[model]:.4f}  ({pct:.1f}%)")


def main():
    parser = argparse.ArgumentParser(description="Parse stage6 Docker logs for cost analysis")
    parser.add_argument("--docker-logs-dir", type=Path, default=DEFAULT_DOCKER_LOGS_DIR,
                        help="Directory with per-benchmark JSONL docker logs")
    parser.add_argument("--pricing", type=Path, default=DEFAULT_PRICING_FILE,
                        help="Path to pricing.json")
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT_FILE,
                        help="Output CSV path")
    args = parser.parse_args()

    if not args.docker_logs_dir.exists():
        print(f"ERROR: Docker logs directory not found: {args.docker_logs_dir}")
        print("Run run_evals_v3.sh first to generate tagged Docker logs.")
        sys.exit(1)

    if not args.pricing.exists():
        print(f"ERROR: Pricing file not found: {args.pricing}")
        sys.exit(1)

    jsonl_files = list(args.docker_logs_dir.glob("*.jsonl"))
    combined = [f for f in jsonl_files if f.name != "all_benchmarks_combined.jsonl"]
    if not combined:
        print(f"ERROR: No per-benchmark JSONL files found in {args.docker_logs_dir}")
        sys.exit(1)

    print(f"Parsing {len(combined)} benchmark log files from {args.docker_logs_dir}")

    pricing = load_pricing(args.pricing)
    print(f"Loaded pricing for {len(pricing)} models")

    records = parse_jsonl_files(args.docker_logs_dir)
    print(f"Extracted {len(records)} records with model+token data")

    rows = aggregate_and_cost(records, pricing)
    write_csv(rows, args.output)


if __name__ == "__main__":
    main()
