#!/usr/bin/env python3
"""Download Dataset A (5,504 routing-eval queries) from the HuggingFace Hub.

Dataset card: https://huggingface.co/datasets/regolo/brick-dataset-A-routing-eval

This is the eval dataset used in the Brick paper (Section 4): 5,504 stratified
queries across 6 capability dimensions, with per-model verdicts for the 3-model
pool (qwen3.5-9b, deepseek-v4-flash, kimi2.6).
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


REPO_ID = "regolo/brick-dataset-A-routing-eval"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--out",
        type=pathlib.Path,
        default=pathlib.Path("./data/dataset_a"),
        help="Local directory where the dataset will be downloaded (default: ./data/dataset_a)",
    )
    parser.add_argument(
        "--revision",
        default="main",
        help="HF Hub revision/branch/tag to fetch (default: main)",
    )
    parser.add_argument(
        "--token",
        default=os.environ.get("HF_TOKEN"),
        help="HuggingFace token. Default: env HF_TOKEN. Public dataset, may not need it.",
    )
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
