"""Benchmark inference latency: single-query + batched.

Usage:
    python bench_latency.py --ckpt outputs/modernbert-winner/best \
        --batch 1 --warmup 100 --n 1000
"""

from __future__ import annotations

import argparse
import statistics
import time

import torch
from transformers import AutoModelForSequenceClassification, AutoTokenizer

SAMPLE_TEXTS = [
    "write a python function to sort a list",
    "explain quantum entanglement briefly",
    "plan a 3-day trip to Tokyo",
    "calculate 12 times 15 plus 7",
    "output JSON with keys x, y",
    "compose a haiku about the moon",
]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--ckpt", required=True)
    ap.add_argument("--batch", type=int, default=1)
    ap.add_argument("--warmup", type=int, default=100)
    ap.add_argument("--n", type=int, default=1000)
    ap.add_argument("--max-length", type=int, default=512)
    args = ap.parse_args()

    tokenizer = AutoTokenizer.from_pretrained(args.ckpt)
    model = (
        AutoModelForSequenceClassification.from_pretrained(
            args.ckpt, torch_dtype=torch.bfloat16, attn_implementation="sdpa"
        )
        .cuda()
        .eval()
    )

    # Prepare batch
    texts = (SAMPLE_TEXTS * (args.batch // len(SAMPLE_TEXTS) + 1))[: args.batch]
    inp = tokenizer(texts, return_tensors="pt", truncation=True, max_length=args.max_length, padding=True).to("cuda")

    # Warmup
    with torch.no_grad():
        for _ in range(args.warmup):
            _ = model(**inp).logits

    torch.cuda.synchronize()
    times_ms = []
    with torch.no_grad():
        for _ in range(args.n):
            t0 = time.perf_counter()
            _ = model(**inp).logits
            torch.cuda.synchronize()
            times_ms.append((time.perf_counter() - t0) * 1000.0)

    p50 = statistics.median(times_ms)
    p99 = sorted(times_ms)[int(len(times_ms) * 0.99)]
    mean = statistics.fmean(times_ms)
    print(f"batch={args.batch}  warmup={args.warmup}  n={args.n}")
    print(f"  p50={p50:.2f} ms")
    print(f"  p99={p99:.2f} ms")
    print(f"  mean={mean:.2f} ms")
    print(f"  per-query (batched): p50={p50 / args.batch:.3f} ms")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
