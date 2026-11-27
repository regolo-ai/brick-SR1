#!/usr/bin/env python3
"""Evaluate an adapted quality/cost selector using RouterBench estimators.

Fit logistic regressions on pretrained MiniLM query embeddings from
RouterBench. Transfer model tiers to qwen/ds4/kimi and select the highest
P(correct) minus lambda times cost. No fitting occurs on Dataset A.
This script does not use the upstream cascade-routing framework and does
not reproduce its full cascade algorithm. Set BRICK_ROUTERBENCH_CSV to the
external RouterBench CSV. Existing cached estimators must be trusted files.
"""

from __future__ import annotations

import json
import os
import pickle
from pathlib import Path

import pandas as pd
from datasets import load_dataset
from sklearn.linear_model import LogisticRegression

REPO = "massaindustries/dataset-A-routing"
OUT = Path(os.environ.get("BRICK_BASELINE_OUTPUT", "./baseline-output")) / Path("cascade_routing.jsonl")
OUT.parent.mkdir(parents=True, exist_ok=True)

ROUTERBENCH_PATH = os.environ["BRICK_ROUTERBENCH_CSV"]

MODEL_MAPPING = {
    "qwen": "mistralai/mistral-7b-chat",
    "ds4": "gpt-3.5-turbo-1106",
    "kimi": "gpt-4-1106-preview",
}
COST_USD_PER_QUERY = {
    "qwen": 0.07e-6,  # $0.07/1M input
    "ds4": 0.50e-6,
    "kimi": 1.00e-6,
}
LAMBDA = 0.5  # weight cost vs quality; fixed RouterBench comparison setting


def embed_queries(texts, batch=128):
    from sentence_transformers import SentenceTransformer

    model = SentenceTransformer("all-MiniLM-L6-v2")
    embs = model.encode(texts, batch_size=batch, show_progress_bar=True, convert_to_numpy=True)
    return embs


def fit_quality_estimators(cache_path: Path):
    if cache_path.exists():
        print(f"[fit] loading cached estimators from {cache_path}")
        return pickle.loads(cache_path.read_bytes())

    print(f"[fit] loading RouterBench from {ROUTERBENCH_PATH}")
    rb = pd.read_csv(ROUTERBENCH_PATH)
    rb_queries = rb["prompt"].astype(str).tolist()
    print(f"[fit] embedding {len(rb_queries)} RouterBench prompts")
    emb = embed_queries(rb_queries)

    estimators = {}
    for our_model, rb_model in MODEL_MAPPING.items():
        if rb_model not in rb.columns:
            raise RuntimeError(f"Column {rb_model} not in RouterBench")
        y = (rb[rb_model] > 0.5).astype(int).values
        print(f"[fit] training LogReg for {our_model} ({rb_model}): pos_rate={y.mean():.3f}")
        clf = LogisticRegression(max_iter=1000, C=1.0)
        clf.fit(emb, y)
        estimators[our_model] = clf
    print(f"[fit] saving cached estimators to {cache_path}")
    cache_path.write_bytes(pickle.dumps(estimators))
    return estimators


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

    cache = Path(os.environ.get("BRICK_BASELINE_OUTPUT", "./baseline-output")) / Path("_cascade_estimators.pkl")
    estimators = fit_quality_estimators(cache)

    ds = load_dataset(REPO, "results", split="train")
    ds = ds.filter(lambda r: r["query_id"] != "_schema_anchor")
    queries = [r["query"] or "" for r in ds]
    qids = [r["query_id"] for r in ds]
    dims = [r["dimension"] for r in ds]
    print(f"[load] {len(queries)} dataset A rows")

    pending_idx = [i for i, q in enumerate(qids) if q not in done_qids]
    print(f"[pending] {len(pending_idx)} to process (per-query encode, no batch)")
    if not pending_idx:
        return

    # Load sentence-transformer ONCE (model load is amortized, not part of per-query latency)
    from sentence_transformers import SentenceTransformer

    print("[init] loading sentence-transformer encoder")
    encoder = SentenceTransformer("all-MiniLM-L6-v2")

    import time as _time

    t0 = _time.time()
    with OUT.open("a") as fout:
        for k, idx in enumerate(pending_idx):
            qid = qids[idx]
            dim = dims[idx]
            q = queries[idx]
            t_router = _time.perf_counter()
            emb = encoder.encode([q], show_progress_bar=False, convert_to_numpy=True)
            scores = {m: float(estimators[m].predict_proba(emb)[0, 1]) for m in MODEL_MAPPING}
            utility = {m: scores[m] - LAMBDA * COST_USD_PER_QUERY[m] * 1e6 for m in MODEL_MAPPING}
            selected = max(utility, key=utility.get)
            router_latency_ms = (_time.perf_counter() - t_router) * 1000
            rec = {
                "query_id": qid,
                "dimension": dim,
                "cascade_selected": selected,
                "cascade_router_latency_ms": router_latency_ms,
                "cascade_p_correct": scores,
                "cascade_utility": utility,
                "cascade_calls": 1,
            }
            fout.write(json.dumps(rec, ensure_ascii=False) + "\n")
            if (k + 1) % 500 == 0:
                fout.flush()
                rate = (k + 1) / (_time.time() - t0)
                print(f"[{k + 1}/{len(pending_idx)}] rate={rate:.2f}/s")

    print(f"[done] {len(pending_idx)} rows in {(_time.time() - t0):.1f}s")


if __name__ == "__main__":
    main()
