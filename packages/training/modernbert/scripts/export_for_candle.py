"""Export winner checkpoint to Candle-ready format: safetensors + config + tokenizer.

Usage:
    python export_for_candle.py --ckpt outputs/top3/rank1/best \
        --output outputs/modernbert-winner/best
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from transformers import AutoModelForSequenceClassification, AutoTokenizer

THIS_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(THIS_DIR))
from dataset_loader import DIMS  # noqa: E402


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--ckpt", required=True)
    ap.add_argument("--output", required=True)
    args = ap.parse_args()

    src = Path(args.ckpt)
    dst = Path(args.output)
    dst.mkdir(parents=True, exist_ok=True)

    # Reload + save with safe_serialization=True (safetensors)
    model = AutoModelForSequenceClassification.from_pretrained(src)
    tokenizer = AutoTokenizer.from_pretrained(src)
    model.save_pretrained(dst, safe_serialization=True)
    tokenizer.save_pretrained(dst)

    # Patch config.json: ensure id2label/label2id canonical
    cfg_path = dst / "config.json"
    cfg = json.loads(cfg_path.read_text())
    cfg["id2label"] = {str(i): d for i, d in enumerate(DIMS)}
    cfg["label2id"] = {d: i for i, d in enumerate(DIMS)}
    cfg["num_labels"] = 6
    cfg["problem_type"] = "multi_label_classification"
    cfg_path.write_text(json.dumps(cfg, indent=2))

    print(f"[done] Candle-ready export → {dst}")
    print("Files:")
    for p in sorted(dst.iterdir()):
        print(f"  {p.name}  ({p.stat().st_size} bytes)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
