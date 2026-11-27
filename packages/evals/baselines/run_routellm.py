#!/usr/bin/env python3
"""RouteLLM zero-shot run on Dataset A (5505 query).

Variants:
  - binary  : weak=qwen, strong=kimi (default RouteLLM binary, exclude ds4)
  - tournament: two binary routers for ternary output qwen|ds4|kimi
      stage1: qwen vs ds4 (if qwen wins -> qwen)
      stage2: ds4 vs kimi (if ds4 wins -> ds4 else kimi)

Router pretrained: `bert` (no OpenAI dep). Threshold default paper: 0.11593.
Append-only JSONL output for resumable evaluation.
"""

from __future__ import annotations

import json
import os
import time
from pathlib import Path

os.environ.setdefault("OPENAI_API_KEY", "sk-dummy")

from datasets import load_dataset
from routellm.controller import Controller

REPO = "massaindustries/dataset-A-routing"
OUT = Path(os.environ.get("BRICK_BASELINE_OUTPUT", "./baseline-output")) / Path("routellm.jsonl")
OUT.parent.mkdir(parents=True, exist_ok=True)
ROUTER_NAME = "bert"
THRESHOLD = 0.11593


def load_dataset_results():
    ds = load_dataset(REPO, "results", split="train")
    ds = ds.filter(lambda r: r["query_id"] != "_schema_anchor")
    return ds


def make_controllers():
    binary = Controller(routers=[ROUTER_NAME], strong_model="kimi", weak_model="qwen")
    tour_low = Controller(routers=[ROUTER_NAME], strong_model="ds4", weak_model="qwen")
    tour_high = Controller(routers=[ROUTER_NAME], strong_model="kimi", weak_model="ds4")
    return binary, tour_low, tour_high


def predict_binary(ctrl, q: str) -> tuple[str, int, float]:
    """Returns (chosen_model, n_router_calls, latency_ms)."""
    t0 = time.perf_counter()
    m = ctrl.route(prompt=q, router=ROUTER_NAME, threshold=THRESHOLD)
    return m, 1, (time.perf_counter() - t0) * 1000


def predict_tournament(low, high, q: str) -> tuple[str, int, float]:
    """Returns (chosen_model_in_{qwen,ds4,kimi}, n_router_calls, latency_ms)."""
    t0 = time.perf_counter()
    s1 = low.route(prompt=q, router=ROUTER_NAME, threshold=THRESHOLD)
    if s1 == "qwen":
        return "qwen", 1, (time.perf_counter() - t0) * 1000
    s2 = high.route(prompt=q, router=ROUTER_NAME, threshold=THRESHOLD)
    return s2, 2, (time.perf_counter() - t0) * 1000


def main():
    done_qids = set()
    if OUT.exists():
        with OUT.open() as f:
            for line in f:
                try:
                    rec = json.loads(line)
                    done_qids.add(rec["query_id"])
                except Exception:
                    pass
        print(f"[resume] {len(done_qids)} rows already in {OUT}")

    ds = load_dataset_results()
    print(f"[load] {len(ds)} rows total")

    binary, tour_low, tour_high = make_controllers()
    print(f"[init] controllers ready, router={ROUTER_NAME}, threshold={THRESHOLD}")

    t0 = time.time()
    n_new = 0
    with OUT.open("a") as fout:
        for _i, row in enumerate(ds):
            qid = row["query_id"]
            if qid in done_qids:
                continue
            q = row["query"] or ""
            try:
                bin_model, bin_calls, bin_lat = predict_binary(binary, q)
                tour_model, tour_calls, tour_lat = predict_tournament(tour_low, tour_high, q)
                err = None
            except Exception as e:
                bin_model = tour_model = None
                bin_calls = tour_calls = 0
                bin_lat = tour_lat = 0.0
                err = str(e)

            rec = {
                "query_id": qid,
                "dimension": row.get("dimension"),
                "routellm_binary_selected": bin_model,
                "routellm_binary_calls": bin_calls,
                "routellm_binary_latency_ms": bin_lat,
                "routellm_tournament_selected": tour_model,
                "routellm_tournament_calls": tour_calls,
                "routellm_tournament_latency_ms": tour_lat,
                "error": err,
            }
            fout.write(json.dumps(rec, ensure_ascii=False) + "\n")
            fout.flush()
            n_new += 1

            if n_new % 200 == 0:
                elapsed = time.time() - t0
                rate = n_new / max(elapsed, 1e-9)
                eta = (len(ds) - len(done_qids) - n_new) / max(rate, 1e-9)
                print(f"[{n_new}/{len(ds) - len(done_qids)}] rate={rate:.1f}/s, eta={eta / 60:.1f}min")

    print(f"[done] processed {n_new} new rows in {(time.time() - t0) / 60:.1f} min")


if __name__ == "__main__":
    main()
