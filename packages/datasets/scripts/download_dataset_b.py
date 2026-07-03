#!/usr/bin/env python3
"""Download Dataset B (ModernBERT capability classifier training set) from HuggingFace Hub.

Dataset card: https://huggingface.co/datasets/massaindustries/dataset-B-modernbert-train

~50k stratified queries labeled across 6 capability dimensions, used to train the
`regolo/brick-modernbert-capability-classifier` ModernBERT-base model (see Brick paper
Section 5 and packages/training/modernbert/).
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


REPO_ID = "massaindustries/dataset-B-modernbert-train"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--out",
        type=pathlib.Path,
        default=pathlib.Path("./data/dataset_b"),
        help="Local directory (default: ./data/dataset_b)",
    )
    parser.add_argument("--revision", default="main")
    parser.add_argument("--token", default=os.environ.get("HF_TOKEN"))
    args = parser.parse_args()

    args.out.mkdir(parents=True, exist_ok=True)
    print(f"Downloading {REPO_ID}@{args.revision} → {args.out} ...")
    local_path = snapshot_download(
        repo_id=REPO_ID,
        repo_type="dataset",
        local_dir=str(args.out),
        revision=args.revision,
        token=args.token,
    )
    print(f"Done. Files under: {local_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
