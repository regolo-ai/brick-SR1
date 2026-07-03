"""Push Dataset B to HF Hub as massaindustries/dataset-B-modernbert-train.

3 splits: train (full minus disagreement subset), human_eval (200), disagreement_review.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
HF_TOKEN_FILE = Path("/root/.hf_token_regolo")
DEFAULT_REPO = "massaindustries/dataset-B-modernbert-train"


def load_records(path: Path) -> list[dict]:
    out = []
    with path.open() as f:
        for line in f:
            out.append(json.loads(line))
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", default=str(ROOT / "data" / "final" / "dataset_b_train.jsonl"))
    ap.add_argument("--human-eval", default=str(ROOT / "data" / "human_eval" / "sample_200_filled.csv"))
    ap.add_argument("--repo", default=DEFAULT_REPO)
    ap.add_argument("--private", action="store_true")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    token = os.environ.get("HF_TOKEN") or (HF_TOKEN_FILE.read_text().strip() if HF_TOKEN_FILE.exists() else None)
    if not token:
        print("[err] no HF token; set HF_TOKEN or write /root/.hf_token_regolo", file=sys.stderr)
        return 2

    records = load_records(Path(args.input))
    train = [r for r in records if not r["disagreement"]]
    review = [r for r in records if r["disagreement"]]

    print(f"[info] train={len(train)} review={len(review)}")
    if args.dry_run:
        return 0

    from datasets import Dataset, DatasetDict
    from huggingface_hub import HfApi

    api = HfApi(token=token)
    api.create_repo(args.repo, repo_type="dataset", private=args.private, exist_ok=True)

    splits = {
        "train": Dataset.from_list(train),
        "disagreement_review": Dataset.from_list(review),
    }
    DatasetDict(splits).push_to_hub(args.repo, token=token)

    # Push human_eval separately as a different config (incompatible schema)
    he_csv = Path(args.human_eval)
    if he_csv.exists():
        import csv as _csv

        with he_csv.open() as f:
            rows = list(_csv.DictReader(f))
        Dataset.from_list(rows).push_to_hub(args.repo, config_name="human_eval", token=token)

    print(f"[done] pushed to https://huggingface.co/datasets/{args.repo}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
