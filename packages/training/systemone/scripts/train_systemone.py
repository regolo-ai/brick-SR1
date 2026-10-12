"""SystemOne single-head training: ModernBERT-large, query -> final_vector (6-dim sigmoid).

W&B-sweep compatible (hyperparams via CLI, dashes match sweep agent flags).
Single-head multi_label_classification, metrics from ../modernbert/scripts/metrics.py.

Usage (on the GPU host):
    python scripts/train_systemone.py --smoke
    python scripts/train_systemone.py --learning-rate 5e-5 --num-train-epochs 4
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

import torch
from transformers import (AutoModelForSequenceClassification, AutoTokenizer,
                          DataCollatorWithPadding, EarlyStoppingCallback,
                          Trainer, TrainingArguments, set_seed)

THIS_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(THIS_DIR))
from dataset_loader_systemone import DIMS, build_train_val  # noqa: E402
from metrics import compute_metrics  # noqa: E402 (vendored from modernbert)

REPO = "answerdotai/ModernBERT-large"


def parse_args() -> argparse.Namespace:
    ap = argparse.ArgumentParser()
    ap.add_argument("--learning_rate", type=float, default=5e-5)
    ap.add_argument("--weight_decay", type=float, default=1e-5)
    ap.add_argument("--warmup_ratio", type=float, default=0.06)
    ap.add_argument("--num_train_epochs", type=int, default=4)
    ap.add_argument("--per_device_train_batch_size", type=int, default=8)
    ap.add_argument("--gradient_accumulation_steps", type=int, default=4)
    ap.add_argument("--max_seq_length", type=int, default=8192)
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--output_dir", default="outputs")
    ap.add_argument("--smoke", action="store_true",
                    help="Quick sanity check: 32 samples, 1 epoch, no W&B")
    ap.add_argument("--no_wandb", action="store_true")
    return ap.parse_args()


def main() -> int:
    args = parse_args()
    set_seed(args.seed)
    print(f"[info] SystemOne ModernBERT-large ({REPO})")
    print(f"[info] LR={args.learning_rate}  WD={args.weight_decay}  "
          f"warmup={args.warmup_ratio}  epochs={args.num_train_epochs}  "
          f"batch={args.per_device_train_batch_size}  "
          f"gradacc={args.gradient_accumulation_steps}  seqlen={args.max_seq_length}")

    tokenizer = AutoTokenizer.from_pretrained(REPO)
    try:
        import flash_attn  # noqa: F401
        attn = "flash_attention_2"
    except ImportError:
        attn = "sdpa"
    print(f"[info] attention implementation: {attn}")
    model = AutoModelForSequenceClassification.from_pretrained(
        REPO,
        num_labels=6,
        problem_type="multi_label_classification",
        id2label={i: d for i, d in enumerate(DIMS)},
        label2id={d: i for i, d in enumerate(DIMS)},
        torch_dtype=torch.bfloat16,
        attn_implementation=attn,
    )

    train_ds, val_ds = build_train_val(
        tokenizer, max_length=args.max_seq_length, seed=args.seed)
    if args.smoke:
        train_ds = train_ds.select(range(min(32, len(train_ds))))
        val_ds = val_ds.select(range(min(32, len(val_ds))))
        args.num_train_epochs = 1
        print("[info] SMOKE mode: 32/32 samples, 1 epoch")

    out_dir = Path(args.output_dir) / "systemone-large"
    out_dir.mkdir(parents=True, exist_ok=True)

    report_to = [] if (args.smoke or args.no_wandb) else ["wandb"]

    # transformers>=5 removed warmup_ratio: convert to warmup_steps.
    import math
    world = torch.cuda.device_count() if torch.cuda.is_available() else 1
    steps_per_epoch = math.ceil(len(train_ds) / max(
        args.per_device_train_batch_size * args.gradient_accumulation_steps * world, 1))
    warmup_steps = int(args.warmup_ratio * steps_per_epoch * args.num_train_epochs)
    print(f"[info] train={len(train_ds)} val={len(val_ds)} "
          f"steps/epoch={steps_per_epoch} warmup_steps={warmup_steps}")

    targs = TrainingArguments(
        output_dir=str(out_dir),
        learning_rate=args.learning_rate,
        per_device_train_batch_size=args.per_device_train_batch_size,
        per_device_eval_batch_size=args.per_device_train_batch_size,
        gradient_accumulation_steps=args.gradient_accumulation_steps,
        num_train_epochs=args.num_train_epochs,
        warmup_steps=warmup_steps,
        weight_decay=args.weight_decay,
        adam_beta1=0.9, adam_beta2=0.98, adam_epsilon=1e-6,
        lr_scheduler_type="linear",
        optim="adamw_torch_fused",
        bf16=True, fp16=False,
        max_grad_norm=1.0,
        eval_strategy="epoch",
        save_strategy="epoch",
        save_total_limit=2,
        load_best_model_at_end=True,
        metric_for_best_model="pearson_macro",
        greater_is_better=True,
        logging_steps=50,
        report_to=report_to,
        seed=args.seed,
        dataloader_num_workers=4,
        dataloader_pin_memory=True,
        ddp_find_unused_parameters=False,
    )

    collator = DataCollatorWithPadding(tokenizer=tokenizer)

    callbacks = []
    if not args.smoke:
        callbacks.append(EarlyStoppingCallback(early_stopping_patience=2))

    import inspect as _inspect
    _trainer_params = set(_inspect.signature(Trainer.__init__).parameters)
    _tok_kw = ("processing_class" if "processing_class" in _trainer_params
               else "tokenizer" if "tokenizer" in _trainer_params else None)
    trainer_kwargs: dict = dict(
        model=model,
        args=targs,
        train_dataset=train_ds,
        eval_dataset=val_ds,
        data_collator=collator,
        compute_metrics=compute_metrics,
        callbacks=callbacks,
    )
    if _tok_kw:
        trainer_kwargs[_tok_kw] = tokenizer
    trainer = Trainer(**trainer_kwargs)
    trainer.train()
    final_metrics = trainer.evaluate()
    print(f"[done] final eval: {final_metrics}")

    best_dir = out_dir / "best"
    trainer.save_model(str(best_dir))
    tokenizer.save_pretrained(str(best_dir))
    print(f"[done] best model saved to {best_dir}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
