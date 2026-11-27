#!/usr/bin/env python3
"""Replay Dataset A through Brick with opt-in router debug headers.

This writes query-level routing internals for offline parameter sweeps. The
backend can still be a fake key/backend; routing decisions and headers are
emitted before the upstream model call completes.
"""

from __future__ import annotations

import argparse
import gzip
import json
import os
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

DEFAULT_RESULTS = Path("./data/dataset_a/results/train.jsonl.gz")
DEFAULT_OUT = Path(os.environ.get("BRICK_BASELINE_OUTPUT", "./baseline-output")) / "brick_debug.jsonl"
DEFAULT_URL = "http://localhost:18000/v1/chat/completions"
MODEL_MAP = {
    "qwen/qwen3.5-9b": "qwen",
    "deepseek/deepseek-v4-flash": "ds4",
    "moonshotai/kimi-k2.6": "kimi",
    "qwen3.5-9b": "qwen",
    "deepseek-v4-flash": "ds4",
    "kimi2.6": "kimi",
}


def derive_ground_truth(row: dict[str, Any]) -> str:
    if row.get("qwen_correct") is True:
        return "qwen"
    if row.get("ds4_correct") is True:
        return "ds4"
    return "kimi"


def load_rows(path: Path) -> list[dict[str, Any]]:
    rows = []
    with gzip.open(path, "rt") as f:
        for line in f:
            if not line.strip():
                continue
            row = json.loads(line)
            if row.get("query_id") == "_schema_anchor":
                continue
            row["ground_truth"] = derive_ground_truth(row)
            rows.append(row)
    return rows


def parse_float_header(headers: Any, name: str) -> float | None:
    raw = headers.get(name)
    if raw is None:
        return None
    try:
        return float(raw)
    except ValueError:
        return None


def call_brick(
    url: str,
    query: str,
    api_key: str,
    timeout: float,
    routing_preference: float | None,
    routing_profile: str | None,
) -> tuple[dict[str, Any], int, float, str | None]:
    body = json.dumps({"model": "brick", "messages": [{"role": "user", "content": query}]}).encode("utf-8")
    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {api_key}",
        "X-Brick-Debug": "1",
    }
    if routing_preference is not None:
        headers["X-Brick-Routing-Preference"] = str(routing_preference)
    if routing_profile:
        headers["X-Brick-Routing-Profile"] = routing_profile
    req = urllib.request.Request(url, data=body, headers=headers)

    status = 0
    err = None
    response_headers = {}
    t0 = time.perf_counter()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            status = resp.status
            response_headers = resp.headers
    except urllib.error.HTTPError as exc:
        status = exc.code
        response_headers = exc.headers or {}
    except Exception as exc:  # network/tunnel failures
        err = str(exc)
    latency_ms = (time.perf_counter() - t0) * 1000

    debug_raw = response_headers.get("X-Brick-Debug") if response_headers else None
    debug = None
    if debug_raw:
        try:
            debug = json.loads(debug_raw)
        except json.JSONDecodeError:
            debug = {"_parse_error": True, "raw": debug_raw}
    selected_raw = response_headers.get("X-Vsr-Selected-Model") if response_headers else None
    if not selected_raw and isinstance(debug, dict):
        selected_raw = debug.get("model")
    route_reason = response_headers.get("X-Brick-Route-Reason") if response_headers else None
    if not route_reason and isinstance(debug, dict):
        route_reason = debug.get("reason")

    out = {
        "brick_selected": MODEL_MAP.get(selected_raw, selected_raw),
        "brick_selected_raw": selected_raw,
        "brick_route_reason": route_reason,
        "brick_tau_query": parse_float_header(response_headers, "X-Brick-Tau-Query") if response_headers else None,
        "brick_effective_tau_query": parse_float_header(response_headers, "X-Brick-Effective-Tau-Query")
        if response_headers
        else None,
        "brick_routing_preference": parse_float_header(response_headers, "X-Brick-Routing-Preference")
        if response_headers
        else None,
        "brick_debug": debug,
    }
    return out, status, latency_ms, err


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--results", type=Path, default=DEFAULT_RESULTS)
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    parser.add_argument("--url", default=DEFAULT_URL)
    parser.add_argument("--api-key", default="sk-fake")
    parser.add_argument("--timeout", type=float, default=30.0)
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--shard-index", type=int, default=0)
    parser.add_argument("--shard-count", type=int, default=1)
    parser.add_argument("--routing-preference", type=float)
    parser.add_argument("--routing-profile", choices=["eco", "balanced", "pro"])
    parser.add_argument("--no-resume", action="store_true")
    args = parser.parse_args()

    if args.shard_count < 1:
        raise SystemExit("--shard-count must be >= 1")
    if args.shard_index < 0 or args.shard_index >= args.shard_count:
        raise SystemExit("--shard-index must be in [0, --shard-count)")

    rows = load_rows(args.results)
    if args.limit:
        rows = rows[: args.limit]
    if args.shard_count > 1:
        rows = [row for i, row in enumerate(rows) if i % args.shard_count == args.shard_index]

    done = set()
    if args.out.exists() and not args.no_resume:
        with args.out.open() as f:
            for line in f:
                if not line.strip():
                    continue
                try:
                    done.add(json.loads(line)["query_id"])
                except Exception:
                    pass
    args.out.parent.mkdir(parents=True, exist_ok=True)

    started = time.time()
    n_new = n_err = 0
    with args.out.open("a") as fout:
        for row in rows:
            qid = row["query_id"]
            if qid in done:
                continue
            brick, status, latency_ms, err = call_brick(
                args.url,
                row.get("query") or "",
                args.api_key,
                args.timeout,
                args.routing_preference,
                args.routing_profile,
            )
            rec = {
                "query_id": qid,
                "dimension": row.get("dimension"),
                "ground_truth": row["ground_truth"],
                "gt_qwen_correct": row.get("qwen_correct"),
                "gt_ds4_correct": row.get("ds4_correct"),
                "gt_kimi_correct": row.get("kimi_correct"),
                **brick,
                "brick_http_status": status,
                "brick_router_latency_ms": latency_ms,
                "brick_correct": brick.get("brick_selected") == row["ground_truth"],
                "error": err,
            }
            fout.write(json.dumps(rec, ensure_ascii=False) + "\n")
            fout.flush()
            n_new += 1
            n_err += bool(err)
            if n_new % 100 == 0:
                elapsed = max(time.time() - started, 1e-9)
                print(f"[{n_new}] rate={n_new / elapsed:.2f}/s err={n_err}")

    print(f"[done] wrote {n_new} new rows to {args.out} err={n_err}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
