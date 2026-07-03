"""ModernBERT capability classifier: main training script.

Single-run training compatible with W&B Sweep agents. Reads hyperparams
from CLI args (and/or wandb.config). Supports --smoke for fast sanity check.

Usage:
    # Smoke test (10 samples, 1 step)
    python train_modernbert.py --smoke --model-size base

    # Single training run (no sweep)
    python train_modernbert.py --model-size base --learning-rate 5e-5 \
        --weight-decay 1e-5 --warmup-ratio 0.06 --num-train-epochs 4

    # Under W&B Sweep agent: hyperparams arrive via CLI flags injected by agent
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import torch
from transformers import (
    AutoModelForSequenceClassification,
    AutoTokenizer,
    DataCollatorWithPadding,
    EarlyStoppingCallback,
    Trainer,
    TrainingArguments,
    set_seed,
)

THIS_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(THIS_DIR))
from dataset_loader import DIMS, build_train_val  # noqa: E402
from metrics import compute_metrics  # noqa: E402

MODEL_REPOS = {
    "base": "answerdotai/ModernBERT-base",
    "large": "answerdotai/ModernBERT-large",
}


def parse_args() -> argparse.Namespace:
    # NOTE: dashes converted to underscores in arg names so W&B sweep agent
    # (which generates --param_name=value) matches our CLI flags.
    ap = argparse.ArgumentParser()
    ap.add_argument("--model_size", choices=["base", "large"], default="base")
    ap.add_argument("--learning_rate", type=float, default=5e-5)
    ap.add_argument("--weight_decay", type=float, default=1e-5)
    ap.add_argument("--warmup_ratio", type=float, default=0.06)
    ap.add_argument("--num_train_epochs", type=int, default=4)
    ap.add_argument("--per_device_train_batch_size", type=int, default=None)
    ap.add_argument("--gradient_accumulation_steps", type=int, default=None)
    ap.add_argument("--max_seq_length", type=int, default=512)
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--output_dir", default="outputs")
    ap.add_argument("--smoke", action="store_true", help="Quick sanity check: 10 samples, 1 step, no W&B")
    ap.add_argument("--no_wandb", action="store_true")
    return ap.parse_args()


def main() -> int:
    args = parse_args()
    set_seed(args.seed)

    # Defaults based on model size
    if args.per_device_train_batch_size is None:
        args.per_device_train_batch_size = 32 if args.model_size == "base" else 16
    if args.gradient_accumulation_steps is None:
        args.gradient_accumulation_steps = 1 if args.model_size == "base" else 2

    repo = MODEL_REPOS[args.model_size]
    print(f"[info] Training ModernBERT-{args.model_size} ({repo})")
    print(
        f"[info] LR={args.learning_rate}  WD={args.weight_decay}  "
        f"warmup={args.warmup_ratio}  epochs={args.num_train_epochs}  "
        f"batch={args.per_device_train_batch_size}  "
        f"gradacc={args.gradient_accumulation_steps}"
    )

    tokenizer = AutoTokenizer.from_pretrained(repo)
    model = AutoModelForSequenceClassification.from_pretrained(
        repo,
        num_labels=6,
        problem_type="multi_label_classification",
        id2label={i: d for i, d in enumerate(DIMS)},
        label2id={d: i for i, d in enumerate(DIMS)},
        torch_dtype=torch.bfloat16,
        attn_implementation="sdpa",
    )

    train_ds, val_ds = build_train_val(tokenizer, max_length=args.max_seq_length, seed=args.seed)
    if args.smoke:
        train_ds = train_ds.select(range(min(10, len(train_ds))))
        val_ds = val_ds.select(range(min(10, len(val_ds))))
        args.num_train_epochs = 1
        print("[info] SMOKE mode: 10/10 samples, 1 epoch")

    out_dir = Path(args.output_dir) / f"modernbert-{args.model_size}"
    out_dir.mkdir(parents=True, exist_ok=True)

    report_to = [] if (args.smoke or args.no_wandb) else ["wandb"]

    targs = TrainingArguments(
        output_dir=str(out_dir),
        learning_rate=args.learning_rate,
        per_device_train_batch_size=args.per_device_train_batch_size,
        per_device_eval_batch_size=args.per_device_train_batch_size,
        gradient_accumulation_steps=args.gradient_accumulation_steps,
        num_train_epochs=args.num_train_epochs,
        warmup_ratio=args.warmup_ratio,
        weight_decay=args.weight_decay,
        adam_beta1=0.9,
        adam_beta2=0.98,
        adam_epsilon=1e-6,
        lr_scheduler_type="linear",
        optim="adamw_torch_fused",
        bf16=True,
        fp16=False,
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

    trainer = Trainer(
        model=model,
        args=targs,
        train_dataset=train_ds,
        eval_dataset=val_ds,
        processing_class=tokenizer,
        data_collator=collator,
        compute_metrics=compute_metrics,
        callbacks=callbacks,
    )
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
