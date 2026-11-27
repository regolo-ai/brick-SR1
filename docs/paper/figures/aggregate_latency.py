"""Aggregate router-overhead and end-to-end latency for the paper.

Sources:
  comparison.jsonl.gz       per-query router_latency_ms for 5 routers (5504 q)
  data/inference/{m}/...    per-model LLM call latency_ms (qwen 1000, ds4/kimi 2943)
  router_requests.jsonl     production Brick decision latency (6376 prod req)

Outputs:
  docs/paper/figures/latency_stats.json   numeric stats consumed by generate_figures.py
  docs/paper/figures/tables_latency.tex   LaTeX tables embedded into paper.tex
"""

from __future__ import annotations

import os
import gzip
import json
import statistics
from pathlib import Path

ROOT = Path(os.environ["BRICK_RESEARCH_INPUT"])
FIG = Path(__file__).resolve().parent
COMP = ROOT / "external_comparison/predictions/comparison.jsonl.gz"
PROD = ROOT / "router_requests.jsonl"
INF_DIR = ROOT / "scientificv1/data/inference"
OUT_JSON = FIG / "latency_stats.json"
OUT_TEX = FIG / "tables_latency.tex"

MODELS = ["qwen3.5-9b", "deepseek-v4-flash", "kimi2.6"]
MODEL_LABEL = {"qwen3.5-9b": "qwen", "deepseek-v4-flash": "ds4", "kimi2.6": "kimi"}
# Brick selected values in comparison.jsonl.gz are short labels.
SHORT_TO_FULL = {"qwen": "qwen3.5-9b", "ds4": "deepseek-v4-flash", "kimi": "kimi2.6"}
ROUTERS_IN_COMPARISON = [
    ("brick", "brick_router_latency_ms"),
    ("cascade", "cascade_router_latency_ms"),
    ("frugal", "frugal_router_latency_ms"),
    ("routellm_binary", "routellm_binary_latency_ms"),
    ("routellm_tournament", "routellm_tournament_latency_ms"),
]


def pct(values, p):
    if not values:
        return 0.0
    s = sorted(values)
    k = int(round((p / 100.0) * (len(s) - 1)))
    return s[k]


def stats(values):
    if not values:
        return {"n": 0, "mean": 0, "p50": 0, "p95": 0, "p99": 0, "max": 0}
    return {
        "n": len(values),
        "mean": statistics.mean(values),
        "p50": pct(values, 50),
        "p95": pct(values, 95),
        "p99": pct(values, 99),
        "max": max(values),
    }


def load_jsonl_gz(path):
    with gzip.open(path, "rt") as f:
        for line in f:
            try:
                yield json.loads(line)
            except json.JSONDecodeError:
                continue


def load_jsonl(path):
    with open(path) as f:
        for line in f:
            try:
                yield json.loads(line)
            except json.JSONDecodeError:
                continue


def collect_inference_latency(model_dir):
    """Concat all latency_ms across deterministic + planning + multi_turn files."""
    out = {}
    for jp in model_dir.glob("*.jsonl"):
        if jp.name.endswith(".bak"):
            continue
        for r in load_jsonl(jp):
            qid = r.get("query_id")
            lat = r.get("latency_ms")
            if qid and lat is not None and lat > 0:
                out[qid] = float(lat)
    return out


def main():
    print("[1/4] router overhead from comparison.jsonl.gz...")
    router_overhead = {name: [] for name, _ in ROUTERS_IN_COMPARISON}
    brick_selected_by_qid = {}
    for r in load_jsonl_gz(COMP):
        qid = r.get("query_id")
        if r.get("brick_selected"):
            brick_selected_by_qid[qid] = r["brick_selected"]
        for name, key in ROUTERS_IN_COMPARISON:
            v = r.get(key)
            if v is not None and v > 0:
                router_overhead[name].append(float(v))
    router_stats = {n: stats(v) for n, v in router_overhead.items()}
    for n, s in router_stats.items():
        print(f"   {n:22s} n={s['n']:5d} p50={s['p50']:7.1f}ms p95={s['p95']:8.1f}ms p99={s['p99']:8.1f}ms")

    print("[2/4] per-model LLM call latency from data/inference/...")
    per_model_lat = {}
    for m in MODELS:
        d = INF_DIR / m
        per_model_lat[m] = collect_inference_latency(d)
        vals = list(per_model_lat[m].values())
        s = stats(vals)
        print(f"   {m:22s} n={s['n']:5d} p50={s['p50']:8.1f}ms p95={s['p95']:9.1f}ms p99={s['p99']:9.1f}ms")
    model_stats = {m: stats(list(per_model_lat[m].values())) for m in MODELS}

    print("[3/4] Brick end-to-end = brick_router_latency + selected_model_LLM_latency...")
    brick_e2e = []
    brick_overhead_only = []
    join_hits = 0
    join_miss = 0
    for r in load_jsonl_gz(COMP):
        qid = r["query_id"]
        sel = r.get("brick_selected")
        router_lat = r.get("brick_router_latency_ms")
        if router_lat is None or router_lat <= 0:
            continue
        if not sel:
            continue
        full = SHORT_TO_FULL.get(sel, sel)
        llm_lat = per_model_lat.get(full, {}).get(qid)
        if llm_lat is None:
            join_miss += 1
            continue
        join_hits += 1
        brick_e2e.append(router_lat + llm_lat)
        brick_overhead_only.append(router_lat)
    print(f"   joined hits={join_hits} miss={join_miss} (queries without LLM latency record)")
    brick_e2e_stats = stats(brick_e2e)
    brick_overhead_stats = stats(brick_overhead_only)
    print(f"   Brick end-to-end p50={brick_e2e_stats['p50']:.1f}ms p95={brick_e2e_stats['p95']:.1f}ms")

    print("[4/4] production Brick latency from router_requests.jsonl...")
    prod_lat = []
    for r in load_jsonl(PROD):
        v = r.get("routing_latency_ms")
        if v is not None and v > 0:
            prod_lat.append(float(v))
    prod_stats = stats(prod_lat)
    print(f"   prod n={prod_stats['n']} p50={prod_stats['p50']:.1f}ms p95={prod_stats['p95']:.1f}ms p99={prod_stats['p99']:.1f}ms")

    # Per-pivot end-to-end stats for the 3 always_X baselines (mean of LLM latency)
    out = {
        "router_overhead_decision_only": router_stats,
        "per_model_llm_latency": model_stats,
        "brick_end_to_end": brick_e2e_stats,
        "brick_decision_only_dataseta": brick_overhead_stats,
        "brick_production_decision_only": prod_stats,
        "brick_e2e_samples": brick_e2e[:2000],
        "per_model_samples": {m: list(per_model_lat[m].values())[:2000] for m in MODELS},
        "router_overhead_samples": {n: router_overhead[n][:2000] for n in router_overhead},
    }
    OUT_JSON.write_text(json.dumps(out, indent=2))
    print(f"[ok] wrote {OUT_JSON}")

    # Emit LaTeX tables (IEEE compatible, no em dash).
    def fmt(v):
        return f"{v:.1f}" if v < 1000 else f"{v:.0f}"

    lines = []
    lines.append("% Auto-generated by docs/paper/figures/aggregate_latency.py. Do not hand-edit.")
    lines.append("")
    lines.append("\\begin{table}[H]")
    lines.append("\\centering")
    lines.append("\\caption{Router decision overhead (LLM call excluded) on Dataset A ($N{=}5{,}504$). All values in milliseconds.}")
    lines.append("\\label{tab:router_overhead}")
    lines.append("\\small")
    lines.append("\\begin{tabular}{l r r r r}")
    lines.append("\\toprule")
    lines.append("\\textbf{Router} & \\textbf{p50} & \\textbf{p95} & \\textbf{p99} & \\textbf{mean} \\\\")
    lines.append("\\midrule")
    label_map = {
        "brick": "Brick (ours)",
        "cascade": "Cascade Routing",
        "frugal": "FrugalGPT",
        "routellm_binary": "RouteLLM binary",
        "routellm_tournament": "RouteLLM tournament",
    }
    for n, s in router_stats.items():
        lines.append(f"{label_map[n]:23s} & {fmt(s['p50'])} & {fmt(s['p95'])} & {fmt(s['p99'])} & {fmt(s['mean'])} \\\\")
    lines.append("\\bottomrule")
    lines.append("\\end{tabular}")
    lines.append("\\end{table}")
    lines.append("")
    lines.append("\\begin{table}[H]")
    lines.append("\\centering")
    lines.append("\\caption{Perceived end-to-end latency (router decision plus LLM generation) on Dataset A. The MoM (Brick max profile) row joins Brick's router latency with the LLM latency of the selected model per query. Single-model baselines show LLM generation latency only.}")
    lines.append("\\label{tab:latency_perceived}")
    lines.append("\\small")
    lines.append("\\begin{tabular}{l r r r r}")
    lines.append("\\toprule")
    lines.append("\\textbf{System} & \\textbf{p50} & \\textbf{p95} & \\textbf{p99} & \\textbf{mean} \\\\")
    lines.append("\\midrule")
    for m, s in model_stats.items():
        lines.append(f"always-{MODEL_LABEL[m]:6s} & {fmt(s['p50'])} & {fmt(s['p95'])} & {fmt(s['p99'])} & {fmt(s['mean'])} \\\\")
    s = brick_e2e_stats
    lines.append(f"\\textbf{{Brick (MoM)}}      & \\textbf{{{fmt(s['p50'])}}} & \\textbf{{{fmt(s['p95'])}}} & \\textbf{{{fmt(s['p99'])}}} & \\textbf{{{fmt(s['mean'])}}} \\\\")
    lines.append("\\bottomrule")
    lines.append("\\end{tabular}")
    lines.append("\\end{table}")
    lines.append("")
    OUT_TEX.write_text("\n".join(lines))
    print(f"[ok] wrote {OUT_TEX}")


if __name__ == "__main__":
    main()
