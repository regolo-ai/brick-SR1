"""Re-evaluate a trained ModernBERT checkpoint on human_eval (Claude annotated).

Usage:
    python eval_human.py --ckpt outputs/top3/rank1/best --output eval_human.json
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import torch
from transformers import (
    AutoModelForSequenceClassification,
    AutoTokenizer,
    DataCollatorWithPadding,
    Trainer,
    TrainingArguments,
)

THIS_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(THIS_DIR))
from dataset_loader import build_human_eval  # noqa: E402
from metrics import compute_metrics  # noqa: E402


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--ckpt", required=True)
    ap.add_argument("--output", default="eval_human.json")
    ap.add_argument("--batch-size", type=int, default=32)
    args = ap.parse_args()

    tokenizer = AutoTokenizer.from_pretrained(args.ckpt)
    model = AutoModelForSequenceClassification.from_pretrained(
        args.ckpt, torch_dtype=torch.bfloat16, attn_implementation="sdpa"
    )
    ds = build_human_eval(tokenizer)

    targs = TrainingArguments(
        output_dir="/tmp/eval_out",
        per_device_eval_batch_size=args.batch_size,
        bf16=True,
        report_to=[],
    )
    trainer = Trainer(
        model=model,
        args=targs,
        processing_class=tokenizer,
        data_collator=DataCollatorWithPadding(tokenizer),
        compute_metrics=compute_metrics,
    )
    metrics = trainer.evaluate(eval_dataset=ds)
    Path(args.output).write_text(json.dumps(metrics, indent=2))
    print(json.dumps(metrics, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
