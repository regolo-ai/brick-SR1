#!/usr/bin/env python3
"""Download Brick HuggingFace models needed by the router (capability + complexity classifiers).

Models:
  - regolo/brick-modernbert-capability-classifier  (ModernBERT-base, 6-label sigmoid)
  - regolo/brick-complexity-2-eco                  (Qwen3.5-0.8B + LoRA, 3-class easy/medium/hard)

These are loaded by the router at startup. Place them under a single root and
point the router config at the resulting paths (config.yaml: capability_model,
complexity_model).
"""

from __future__ import annotations

import argparse
import os
import pathlib
import sys

try:
    from huggingface_hub import snapshot_download
except ImportError:
    sys.exit("ERROR: missing dependency. Install with `uv pip install huggingface_hub`")


MODELS = [
    ("regolo/brick-modernbert-capability-classifier", "capability-classifier"),
    ("regolo/brick-complexity-2-eco", "complexity-classifier"),
]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--out",
        type=pathlib.Path,
        default=pathlib.Path("./models"),
        help="Root directory (each model goes under <out>/<short-name>/, default: ./models)",
    )
    parser.add_argument("--revision", default="main")
    parser.add_argument("--token", default=os.environ.get("HF_TOKEN"))
    args = parser.parse_args()

    args.out.mkdir(parents=True, exist_ok=True)
    for repo_id, short in MODELS:
        target = args.out / short
        target.mkdir(parents=True, exist_ok=True)
        print(f"\n→ {repo_id}@{args.revision}  ⇢  {target}")
        snapshot_download(
            repo_id=repo_id,
            repo_type="model",
            local_dir=str(target),
            revision=args.revision,
            token=args.token,
        )
    print(f"\nDone. Models under: {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
