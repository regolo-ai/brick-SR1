#!/usr/bin/env python3
"""
Split router log entries by benchmark, show per-model routing breakdown and costs.
Combines Docker log analysis with existing eval cost data (cost_report.csv).

Outputs:
  - router_by_benchmark.jsonl   — every router call tagged with its benchmark
  - benchmark_cost_summary.csv  — aggregated cost/token summary per benchmark+model
"""

import csv
import json
from collections import defaultdict
from pathlib import Path

# ---------------------------------------------------------------------------
# Pricing (EUR, from evals/pricing.json)
# ---------------------------------------------------------------------------
PRICING = {
    "gpt-oss-120b": {"input": 1.00, "output": 4.20},
    "gpt-oss-20b": {"input": 0.10, "output": 0.42},
    "qwen3-8b": {"input": 0.07, "output": 0.35},
    "Qwen3-8B": {"input": 0.07, "output": 0.35},
    "qwen3-coder-next": {"input": 0.50, "output": 2.00},
    "Llama-3.3-70B-Instruct": {"input": 0.60, "output": 2.70},
    "mistral-small3.2": {"input": 0.50, "output": 2.20},
    "gemma-3-27b-it": {"input": 0.50, "output": 2.50},
}


def classify_benchmark(query_text: str) -> str:
    """Classify a query into its benchmark based on text patterns."""
    if not query_text:
        return "unknown"
    if query_text.startswith("Problem:"):
        return "minerva_math"
    # Everything else in the March 5 logs is IFEval
    return "ifeval"


def main():
    input_file = Path("/root/forkGO/router_requests.jsonl")
    output_jsonl = Path("/root/forkGO/router_by_benchmark.jsonl")
    output_csv = Path("/root/forkGO/benchmark_cost_summary.csv")
    cost_report_csv = Path("/root/forkGO/spatial-routing/evals/cost_report.csv")

    # ── Step 1: Load and classify router log entries ──────────────────────
    records = []
    with open(input_file) as f:
        for line in f:
            r = json.loads(line)
            if r.get("source") != "brick-router":
                continue
            r["benchmark"] = classify_benchmark(r.get("query_text", ""))
            records.append(r)

    records.sort(key=lambda r: r.get("timestamp", ""))

    # ── Step 2: Write tagged JSONL ────────────────────────────────────────
    with open(output_jsonl, "w") as f:
        for r in records:
            f.write(json.dumps(r, ensure_ascii=False, default=str) + "\n")
    print(f"Wrote {len(records)} tagged records -> {output_jsonl}")

    # ── Step 3: Aggregate per benchmark + model ───────────────────────────
    # Structure: {benchmark -> {model -> {count, input_tokens, body_size_total}}}
    agg = defaultdict(
        lambda: defaultdict(
            lambda: {
                "count": 0,
                "input_tokens": 0,
                "request_body_bytes": 0,
                "decisions": defaultdict(int),
            }
        )
    )

    for r in records:
        bench = r["benchmark"]
        model = r.get("selected_model", "unknown")
        bucket = agg[bench][model]
        bucket["count"] += 1
        bucket["input_tokens"] += r.get("query_token_count", r.get("query_token_count_estimated", 0))
        bucket["request_body_bytes"] += r.get("request_body_size", 0)
        dec = r.get("decision", "") or "(default/fallback)"
        bucket["decisions"][dec] += 1

    # ── Step 4: Load existing cost_report.csv for baseline comparison ─────
    existing_costs = {}
    if cost_report_csv.exists():
        with open(cost_report_csv) as f:
            reader = csv.DictReader(f)
            for row in reader:
                key = (row["benchmark"], row["model"])
                existing_costs[key] = {
                    "display_name": row["display_name"],
                    "score": row["score"],
                    "num_samples": int(row["num_samples"]),
                    "input_tokens": int(row["input_tokens"]),
                    "output_tokens": int(row["output_tokens"]),
                    "total_tokens": int(row["total_tokens"]),
                    "total_cost_eur": row["total_cost_eur"],
                }

    # ── Step 5: Write summary CSV ─────────────────────────────────────────
    csv_rows = []

    for bench in sorted(agg.keys()):
        models = agg[bench]
        total_count = sum(m["count"] for m in models.values())
        total_tokens = sum(m["input_tokens"] for m in models.values())

        for model in sorted(models.keys(), key=lambda m: models[m]["count"], reverse=True):
            bucket = models[model]
            pct = (bucket["count"] / total_count * 100) if total_count > 0 else 0
            pricing = PRICING.get(model, {})
            input_price = pricing.get("input", 0)
            output_price = pricing.get("output", 0)

            # Estimate input cost from router logs
            est_input_cost = bucket["input_tokens"] * input_price / 1_000_000

            # Get baseline from cost_report.csv (what it costs to run the entire
            # benchmark with this model alone)
            # Map model names to short names for lookup
            model_short_map = {
                "gpt-oss-120b": "gptoss120b",
                "gpt-oss-20b": "gptoss20b",
                "qwen3-8b": "qwen3_8b",
                "Qwen3-8B": "qwen3_8b",
                "qwen3-coder-next": "qwen3coder",
                "Llama-3.3-70B-Instruct": "llama70b",
                "mistral-small3.2": "mistral32",
                "gemma-3-27b-it": "gemma27b",
            }
            model_short = model_short_map.get(model, model)
            baseline = existing_costs.get((bench, model_short), {})

            # Top decisions
            top_decisions = sorted(bucket["decisions"].items(), key=lambda x: -x[1])[:3]
            decisions_str = "; ".join(f"{d}:{c}" for d, c in top_decisions)

            csv_rows.append(
                {
                    "benchmark": bench,
                    "selected_model": model,
                    "brick_routed_count": bucket["count"],
                    "brick_routed_pct": round(pct, 1),
                    "brick_routed_input_tokens": bucket["input_tokens"],
                    "brick_routed_body_bytes": bucket["request_body_bytes"],
                    "est_input_cost_eur": round(est_input_cost, 6),
                    "price_per_1m_input_eur": input_price,
                    "price_per_1m_output_eur": output_price,
                    "top_routing_decisions": decisions_str,
                    "baseline_score": baseline.get("score", ""),
                    "baseline_total_samples": baseline.get("num_samples", ""),
                    "baseline_input_tokens": baseline.get("input_tokens", ""),
                    "baseline_output_tokens": baseline.get("output_tokens", ""),
                    "baseline_total_cost_eur": baseline.get("total_cost_eur", ""),
                }
            )

    # Also add brick totals per benchmark
    for bench in sorted(agg.keys()):
        models = agg[bench]
        total_count = sum(m["count"] for m in models.values())
        total_input_tokens = sum(m["input_tokens"] for m in models.values())
        total_body_bytes = sum(m["request_body_bytes"] for m in models.values())

        # Calculate weighted cost (actual brick cost = sum of individual model costs)
        weighted_cost = 0
        for model, bucket in models.items():
            pricing = PRICING.get(model, {})
            weighted_cost += bucket["input_tokens"] * pricing.get("input", 0) / 1_000_000

        brick_baseline = existing_costs.get((bench, "brick"), {})

        csv_rows.append(
            {
                "benchmark": bench,
                "selected_model": "=== BRICK TOTAL ===",
                "brick_routed_count": total_count,
                "brick_routed_pct": 100.0,
                "brick_routed_input_tokens": total_input_tokens,
                "brick_routed_body_bytes": total_body_bytes,
                "est_input_cost_eur": round(weighted_cost, 6),
                "price_per_1m_input_eur": "",
                "price_per_1m_output_eur": "",
                "top_routing_decisions": "",
                "baseline_score": brick_baseline.get("score", ""),
                "baseline_total_samples": brick_baseline.get("num_samples", ""),
                "baseline_input_tokens": brick_baseline.get("input_tokens", ""),
                "baseline_output_tokens": brick_baseline.get("output_tokens", ""),
                "baseline_total_cost_eur": brick_baseline.get("total_cost_eur", ""),
            }
        )

    fieldnames = list(csv_rows[0].keys())
    with open(output_csv, "w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(csv_rows)
    print(f"Wrote {len(csv_rows)} rows -> {output_csv}")

    # ── Step 6: Print report ──────────────────────────────────────────────
    print("\n" + "=" * 90)
    print("BRICK ROUTER — COST BREAKDOWN PER BENCHMARK (from Docker logs March 5)")
    print("=" * 90)

    for bench in sorted(agg.keys()):
        models = agg[bench]
        total_count = sum(m["count"] for m in models.values())
        total_tokens = sum(m["input_tokens"] for m in models.values())
        brick_baseline = existing_costs.get((bench, "brick"), {})
        brick_score = brick_baseline.get("score", "N/A")

        print(f"\n{'─' * 90}")
        print(f"  BENCHMARK: {bench.upper()}")
        print(f"  Total requests: {total_count}  |  Total input tokens: {total_tokens:,}")
        print(f"  Brick score (stage2): {brick_score}")
        print(f"{'─' * 90}")
        print(f"  {'Model':<28} {'Calls':>7} {'%':>7} {'Input Tok':>12} {'Est.Cost(EUR)':>14} {'Decision':>25}")
        print(f"  {'-' * 28} {'-' * 7} {'-' * 7} {'-' * 12} {'-' * 14} {'-' * 25}")

        weighted_cost = 0
        for model in sorted(models.keys(), key=lambda m: models[m]["count"], reverse=True):
            bucket = models[model]
            pct = bucket["count"] / total_count * 100
            pricing = PRICING.get(model, {})
            cost = bucket["input_tokens"] * pricing.get("input", 0) / 1_000_000
            weighted_cost += cost
            top_dec = sorted(bucket["decisions"].items(), key=lambda x: -x[1])
            dec_str = top_dec[0][0] if top_dec else ""
            print(
                f"  {model:<28} {bucket['count']:>7} {pct:>6.1f}% {bucket['input_tokens']:>12,} EUR {cost:>10.6f} {dec_str:>25}"
            )

        print(f"  {'─' * 28} {'─' * 7} {'─' * 7} {'─' * 12} {'─' * 14}")
        print(
            f"  {'BRICK WEIGHTED TOTAL':<28} {total_count:>7} {'100%':>7} {total_tokens:>12,} EUR {weighted_cost:>10.6f}"
        )

        # Show what individual models cost on this benchmark (from cost_report.csv)
        print("\n  Comparison with individual model baselines (stage2 eval):")
        print(f"  {'Model':<28} {'Score':>8} {'Samples':>8} {'In Tok':>12} {'Out Tok':>12} {'Total Cost':>12}")
        print(f"  {'-' * 28} {'-' * 8} {'-' * 8} {'-' * 12} {'-' * 12} {'-' * 12}")
        for (b, _m), data in sorted(existing_costs.items()):
            if b == bench:
                score_str = f"{float(data['score']) * 100:.1f}%" if data["score"] else "N/A"
                cost_str = f"EUR {float(data['total_cost_eur']):.4f}" if data["total_cost_eur"] else "N/A"
                print(
                    f"  {data['display_name']:<28} {score_str:>8} {data['num_samples']:>8} {data['input_tokens']:>12,} {data['output_tokens']:>12,} {cost_str:>12}"
                )


if __name__ == "__main__":
    main()
