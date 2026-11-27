#!/usr/bin/env python3
"""Measure Dataset A routing through a running Brick endpoint. The selected-model header records the decision even when the deliberately invalid upstream key causes HTTP 401. Latency includes the failed upstream round trip."""

from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.request
from pathlib import Path

os.environ.setdefault(
    "HF_TOKEN",
    (Path.home() / ".hf_token_regolo").read_text().strip() if (Path.home() / ".hf_token_regolo").exists() else "",
)

from datasets import load_dataset

REPO = "massaindustries/dataset-A-routing"
OUT = Path(os.environ.get("BRICK_BASELINE_OUTPUT", "./baseline-output")) / "brick.jsonl"
OUT.parent.mkdir(parents=True, exist_ok=True)

BRICK_URL = "http://localhost:18000/v1/chat/completions"  # SSH tunnel → qwen-bench:18000 (GPU node)
MAP = {
    "qwen/qwen3.5-9b": "qwen",
    "deepseek/deepseek-v4-flash": "ds4",
    "moonshotai/kimi-k2.6": "kimi",
}


def call_brick(query: str, timeout: float = 30.0) -> tuple[str | None, str | None, int, float, str | None]:
    """Returns (selected_short, route_reason, http_status, latency_ms, error)."""
    body = json.dumps({"model": "brick", "messages": [{"role": "user", "content": query}]}).encode("utf-8")
    req = urllib.request.Request(
        BRICK_URL,
        data=body,
        headers={"Content-Type": "application/json", "Authorization": "Bearer sk-fake"},
    )
    t0 = time.perf_counter()
    sel_raw = reason = err = None
    status = 0
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            sel_raw = r.headers.get("X-Vsr-Selected-Model")
            reason = r.headers.get("X-Brick-Route-Reason")
            status = r.status
    except urllib.error.HTTPError as e:
        sel_raw = e.headers.get("X-Vsr-Selected-Model") if e.headers else None
        reason = e.headers.get("X-Brick-Route-Reason") if e.headers else None
        status = e.code
    except Exception as e:
        err = str(e)
    lat = (time.perf_counter() - t0) * 1000
    short = MAP.get(sel_raw) if sel_raw else None
    return short, reason, status, lat, err


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

    ds = load_dataset(REPO, "results", split="train")
    ds = ds.filter(lambda r: r["query_id"] != "_schema_anchor")
    print(f"[load] {len(ds)} rows total")

    t0 = time.time()
    n_new = 0
    n_err = 0
    n_no_header = 0
    with OUT.open("a") as fout:
        for _i, row in enumerate(ds):
            qid = row["query_id"]
            if qid in done_qids:
                continue
            q = row["query"] or ""
            short, reason, status, lat, err = call_brick(q)
            if err:
                n_err += 1
            if short is None:
                n_no_header += 1
            rec = {
                "query_id": qid,
                "dimension": row.get("dimension"),
                "brick_selected": short,
                "brick_route_reason": reason,
                "brick_http_status": status,
                "brick_router_latency_ms": lat,
                "error": err,
            }
            fout.write(json.dumps(rec, ensure_ascii=False) + "\n")
            fout.flush()
            n_new += 1
            if n_new % 100 == 0:
                elapsed = time.time() - t0
                rate = n_new / max(elapsed, 1e-9)
                remaining = (len(ds) - len(done_qids) - n_new) / max(rate, 1e-9)
                print(
                    f"[{n_new}/{len(ds) - len(done_qids)}] rate={rate:.2f}/s  eta={remaining / 60:.1f}min  err={n_err}  no_header={n_no_header}"
                )

    print(f"[done] {n_new} rows in {(time.time() - t0) / 60:.1f} min (err={n_err} no_header={n_no_header})")


if __name__ == "__main__":
    main()
