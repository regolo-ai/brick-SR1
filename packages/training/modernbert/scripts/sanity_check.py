"""Semantic sanity check: 6 canonical prompts → assert argmax matches expected dim.

Usage:
    python sanity_check.py --ckpt outputs/modernbert-winner/best
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import torch
from transformers import AutoModelForSequenceClassification, AutoTokenizer

THIS_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(THIS_DIR))
from dataset_loader import DIMS  # noqa: E402

SAMPLES = [
    ("write a python function to sort a list of integers", "coding"),
    ("explain Newton's third law of motion", "world_knowledge"),
    ("write a haiku about autumn leaves falling", "creative_synthesis"),
    ("calculate 12 multiplied by 15 plus 7 minus 3", "math_reasoning"),
    ("output a JSON object with exactly keys x, y, z and no extra fields", "instruction_following"),
    ("design a 5-step plan to migrate our service to kubernetes", "planning_agentic"),
]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--ckpt", required=True)
    args = ap.parse_args()

    tokenizer = AutoTokenizer.from_pretrained(args.ckpt)
    model = (
        AutoModelForSequenceClassification.from_pretrained(
            args.ckpt, torch_dtype=torch.bfloat16, attn_implementation="sdpa"
        )
        .cuda()
        .eval()
    )

    n_pass = 0
    for text, expected in SAMPLES:
        inp = tokenizer(text, return_tensors="pt", truncation=True, max_length=512).to("cuda")
        with torch.no_grad():
            logits = model(**inp).logits.float().cpu()
        scores = torch.sigmoid(logits)[0].tolist()
        top_idx = max(range(6), key=lambda i: scores[i])
        top_dim = DIMS[top_idx]
        ok = top_dim == expected
        n_pass += int(ok)
        marker = "PASS" if ok else "FAIL"
        score_str = "  ".join(f"{d}={s:.2f}" for d, s in zip(DIMS, scores, strict=False))
        print(f"[{marker}] {text!r:65s}  expected={expected:22s} top={top_dim:22s}")
        print(f"        {score_str}")
    print(f"\n{n_pass}/{len(SAMPLES)} PASS")
    return 0 if n_pass == len(SAMPLES) else 1


if __name__ == "__main__":
    raise SystemExit(main())
