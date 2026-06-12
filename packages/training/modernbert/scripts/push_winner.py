"""Push winner ModernBERT checkpoint to HF Hub.

Usage:
    python push_winner.py --ckpt outputs/modernbert-winner/best \
        --repo massaindustries/modernbert-capability-classifier
"""
from __future__ import annotations
import argparse
import json
import os
import sys
from pathlib import Path

HF_TOKEN_FILE = Path("/root/.hf_token_regolo")
HF_TOKEN_FILE_HOME = Path.home() / ".hf_token_regolo"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--ckpt", required=True)
    ap.add_argument("--repo", required=True)
    ap.add_argument("--private", action="store_true")
    ap.add_argument("--eval-report", default=None,
                    help="Path to eval_human.json to include in card")
    args = ap.parse_args()

    token = os.environ.get("HF_TOKEN")
    for p in (HF_TOKEN_FILE, HF_TOKEN_FILE_HOME):
        if token:
            break
        try:
            if p.exists():
                token = p.read_text().strip()
        except PermissionError:
            continue
    if not token:
        print("[err] no HF token", file=sys.stderr)
        return 2

    from huggingface_hub import HfApi, upload_folder
    api = HfApi(token=token)
    api.create_repo(args.repo, repo_type="model", private=args.private,
                    exist_ok=True)

    # Generate README dataset card
    card = [
        "---",
        f"base_model: answerdotai/ModernBERT-base",
        "library_name: transformers",
        "license: apache-2.0",
        "datasets:",
        "  - massaindustries/dataset-B-modernbert-train",
        "tags:",
        "  - text-classification",
        "  - multi-label",
        "  - modernbert",
        "  - capability-classifier",
        "  - routing",
        "---",
        "",
        "# ModernBERT capability classifier (6 dimensions)",
        "",
        "Fine-tuned on [`massaindustries/dataset-B-modernbert-train`]"
        "(https://huggingface.co/datasets/massaindustries/dataset-B-modernbert-train).",
        "Outputs sigmoid scores in [0,1] over 6 capability dimensions:",
        "",
        "1. `instruction_following`",
        "2. `coding`",
        "3. `math_reasoning`",
        "4. `world_knowledge`",
        "5. `planning_agentic`",
        "6. `creative_synthesis`",
        "",
        "Designed for downstream routing in the Brick spatial router as a "
        "drop-in replacement for the domain classifier.",
        "",
        "## Training",
        "- Architecture: ModernBERT + Linear(hidden→6) + sigmoid",
        "- Loss: BCEWithLogitsLoss on soft float labels (judge mean)",
        "- Precision: bf16 + FlashAttention-2",
        "- HF problem_type: `multi_label_classification`",
        "",
        "## Inference example",
        "```python",
        "from transformers import AutoModelForSequenceClassification, AutoTokenizer",
        "import torch",
        f"m = AutoModelForSequenceClassification.from_pretrained('{args.repo}')",
        f"t = AutoTokenizer.from_pretrained('{args.repo}')",
        "inp = t('write a python sort function', return_tensors='pt')",
        "scores = torch.sigmoid(m(**inp).logits)[0]",
        "for i, d in enumerate(m.config.id2label.values()):",
        "    print(f'{d}: {scores[i].item():.3f}')",
        "```",
    ]
    if args.eval_report and Path(args.eval_report).exists():
        report = json.loads(Path(args.eval_report).read_text())
        card.extend(["", "## Evaluation (human_eval split, 200 Claude-annotated)",
                     "```json",
                     json.dumps(report, indent=2)[:2000],
                     "```"])
    (Path(args.ckpt) / "README.md").write_text("\n".join(card))

    upload_folder(folder_path=args.ckpt, repo_id=args.repo,
                  repo_type="model", token=token,
                  commit_message="upload trained ModernBERT capability classifier")
    print(f"[done] https://huggingface.co/{args.repo}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
