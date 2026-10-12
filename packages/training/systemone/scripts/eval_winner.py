"""Final winner evaluation: full holdout + slices (disagreement, short/long) + latency bench.

Usage (GPU host):
    python scripts/eval_winner.py --ckpt outputs/systemone-large/best [--bench-only]
"""
from __future__ import annotations

import argparse
import statistics
import sys
import time
from pathlib import Path

import numpy as np
import torch
from transformers import AutoModelForSequenceClassification, AutoTokenizer

THIS_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(THIS_DIR))
from dataset_loader_systemone import DIMS, build_train_val  # noqa: E402
from metrics import compute_metrics  # noqa: E402


def sigmoid(x: np.ndarray) -> np.ndarray:
    return 1 / (1 + np.exp(-x))


def eval_split(model, tok, rows: list[dict], device: str, bs: int = 8) -> dict:
    logits_all, labels_all = [], []
    model.eval()
    with torch.no_grad():
        for i in range(0, len(rows), bs):
            chunk = rows[i:i + bs]
            enc = tok([r["query"] for r in chunk], padding=True, truncation=True,
                      max_length=8192, return_tensors="pt").to(device)
            out = model(**enc).logits.float().cpu().numpy()
            logits_all.append(out)
            labels_all.append(np.array([r["labels"] for r in chunk], dtype=np.float32))
    res = compute_metrics((np.concatenate(logits_all), np.concatenate(labels_all)))
    return {k: round(float(v), 4) for k, v in res.items()
            if k.startswith(("pearson_macro", "mae_macro", "spearman_macro", "f1_"))
            or k.startswith("pearson_")}


@torch.no_grad()
def bench(model, tok, device: str, warmup: int = 20, n: int = 100):
    texts = {
        "short": "write a python function to sort a list",
        "long8k": None,  # filled below
    }
    import random
    random.seed(0)
    filler = "Consider the following distributed cache invalidation scenario. " * 150
    texts["long8k"] = (filler + "Explain the failure modes.")[:30000]
    out = {}
    for name, t in texts.items():
        enc = tok([t], return_tensors="pt", truncation=True,
                  max_length=8192).to(device)
        seqlen = int(enc["attention_mask"].sum())
        for _ in range(warmup):
            _ = model(**enc).logits
        torch.cuda.synchronize()
        ts = []
        for _ in range(n):
            t0 = time.perf_counter()
            _ = model(**enc).logits
            torch.cuda.synchronize()
            ts.append((time.perf_counter() - t0) * 1000)
        out[name] = {"tokens": seqlen, "p50_ms": round(statistics.median(ts), 2),
                     "p99_ms": round(sorted(ts)[int(len(ts) * 0.99)], 2)}
    # batched shorts
    enc = tok([texts["short"]] * 8, return_tensors="pt", padding=True,
              truncation=True, max_length=8192).to(device)
    for _ in range(warmup):
        _ = model(**enc).logits
    torch.cuda.synchronize()
    ts = []
    for _ in range(n):
        t0 = time.perf_counter()
        _ = model(**enc).logits
        torch.cuda.synchronize()
        ts.append((time.perf_counter() - t0) * 1000)
    out["batch8_short"] = {"p50_ms": round(statistics.median(ts), 2),
                           "per_query_ms": round(statistics.median(ts) / 8, 3)}
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--ckpt", required=True)
    ap.add_argument("--bench-only", action="store_true")
    args = ap.parse_args()

    device = "cuda" if torch.cuda.is_available() else "cpu"
    dtype = torch.bfloat16 if device == "cuda" else torch.float32
    tok = AutoTokenizer.from_pretrained(args.ckpt)
    try:
        import flash_attn  # noqa: F401
        attn = "flash_attention_2"
    except ImportError:
        attn = "sdpa"
    model = AutoModelForSequenceClassification.from_pretrained(
        args.ckpt, torch_dtype=dtype, attn_implementation=attn).to(device).eval()
    print(f"[eval] device={device} attn={attn} ckpt={args.ckpt}")

    if not args.bench_only:
        import os
        from datasets import load_dataset
        from dataset_loader_systemone import _hf_token, _make_labels
        full = load_dataset("massaindustries/systemone-50k-train",
                            token=_hf_token() or os.environ.get("HF_TOKEN"))["train"]
        full = full.map(lambda r: {"labels": _make_labels(r)}, desc="labels")
        full = full.class_encode_column("disagreement")
        val = full.train_test_split(test_size=0.1, seed=42,
                                    stratify_by_column="disagreement")["test"]
        rows = [{"query": r["query"], "labels": r["labels"],
                 "disagreement": r["disagreement"],
                 "long": r["context_length"] > 2000} for r in val]
        print(f"[eval] val rows={len(rows)}")

        full_m = eval_split(model, tok, rows, device)
        print("[eval] FULL:", {k: v for k, v in full_m.items() if "_macro" in k or k.startswith("f1_")})
        print("[eval] PER-DIM pearson:", {d: full_m[f"pearson_{d}"] for d in DIMS})
        dis = [r for r in rows if r["disagreement"]]
        Agr = [r for r in rows if not r["disagreement"]]
        print("[eval] DISAGREE-TRUE:", {k: v for k, v in eval_split(model, tok, dis, device).items() if "macro" in k})
        print("[eval] DISAGREE-FALSE:", {k: v for k, v in eval_split(model, tok, Agr, device).items() if "macro" in k})
        long = [r for r in rows if r["long"]]
        short = [r for r in rows if not r["long"]]
        print(f"[eval] LONG(n={len(long)}):", {k: v for k, v in eval_split(model, tok, long, device).items() if "macro" in k})
        print(f"[eval] SHORT(n={len(short)}):", {k: v for k, v in eval_split(model, tok, short, device).items() if "macro" in k})

    print("[bench]", bench(model, tok, device))
    return 0


if __name__ == "__main__":
    sys.exit(main())
