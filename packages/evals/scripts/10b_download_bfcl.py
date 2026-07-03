#!/usr/bin/env python3
"""10b - Download BFCL via list_repo_files (load_dataset non funziona).

Stratifica 500 task tra categorie {simple, multiple, parallel, parallel_multiple, irrelevance}.
Output: data/raw/bfcl_v4.jsonl
"""

from __future__ import annotations

import json
import random
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from brick_evals.io_utils import data_dir, hf_token, save_jsonl, utc_now_iso

REPO = "gorilla-llm/Berkeley-Function-Calling-Leaderboard"
TARGET_N = 500
SEED = 42

# Categorie BFCL: questions file + (optional) possible_answer file with ground_truth
# irrelevance: by design senza possible_answer (categoria "non chiamare nessun tool", gt=[] è corretto)
CATEGORIES = {
    "simple": {"questions": "BFCL_v3_simple.json", "answers": "possible_answer/BFCL_v3_simple.json"},
    "multiple": {"questions": "BFCL_v3_multiple.json", "answers": "possible_answer/BFCL_v3_multiple.json"},
    "parallel": {"questions": "BFCL_v3_parallel.json", "answers": "possible_answer/BFCL_v3_parallel.json"},
    "parallel_multiple": {
        "questions": "BFCL_v3_parallel_multiple.json",
        "answers": "possible_answer/BFCL_v3_parallel_multiple.json",
    },
    "irrelevance": {"questions": "BFCL_v3_irrelevance.json", "answers": None},
}

# Quote stratificate (somma 500)
QUOTE = {
    "simple": 200,
    "multiple": 100,
    "parallel": 80,
    "parallel_multiple": 80,
    "irrelevance": 40,
}


def _load_jsonl_from_hub(filename: str) -> list[dict]:
    from huggingface_hub import hf_hub_download

    path = hf_hub_download(
        repo_id=REPO,
        filename=filename,
        repo_type="dataset",
        token=hf_token(),
    )
    out = []
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                try:
                    out.append(json.loads(line))
                except json.JSONDecodeError:
                    continue
    return out


def main():
    from huggingface_hub import HfApi

    api = HfApi(token=hf_token())
    files = set(api.list_repo_files(repo_id=REPO, repo_type="dataset"))
    print(f"BFCL repo has {len(files)} files")

    rng = random.Random(SEED)
    all_rows = []
    n_with_gt = 0
    n_irrelevance = 0

    for cat, paths in CATEGORIES.items():
        target_cat = QUOTE[cat]
        q_file = paths["questions"]
        a_file = paths["answers"]

        if q_file not in files:
            print(f"  [SKIP] {cat}: questions file {q_file} not in repo")
            continue
        try:
            qrows = _load_jsonl_from_hub(q_file)
        except Exception as e:
            print(f"  [SKIP] {cat}: failed loading {q_file}: {e}")
            continue

        # Load possible_answer file and build id -> ground_truth map
        gt_map: dict = {}
        if a_file and a_file in files:
            try:
                arows = _load_jsonl_from_hub(a_file)
                gt_map = {r["id"]: r.get("ground_truth", []) for r in arows if "id" in r}
                print(f"  [GT] {cat:20s} <- {a_file} ({len(gt_map)} ground_truth entries)")
            except Exception as e:
                print(f"  [warn] failed loading {a_file}: {e}")

        # Join: populate ground_truth on each question row
        merged = []
        for r in qrows:
            rid = r.get("id")
            if cat == "irrelevance":
                # by design: no tool should be called → empty gt is correct
                r["ground_truth"] = []
            else:
                gt = gt_map.get(rid)
                if gt is None:
                    # Skip rows without gt match (would be unevaluable)
                    continue
                r["ground_truth"] = gt
            merged.append(r)

        n_avail = len(merged)
        n_drop = len(qrows) - n_avail
        if n_drop > 0:
            print(f"  [warn] {cat}: dropped {n_drop} rows without gt match")
        print(f"  [OK]  {cat:20s} <- {q_file} ({n_avail} rows with gt)")

        sample = rng.sample(merged, min(target_cat, n_avail))
        for r in sample:
            r["_category"] = cat
            if cat == "irrelevance":
                n_irrelevance += 1
            else:
                if r["ground_truth"]:
                    n_with_gt += 1
        all_rows.extend(sample)

    print(
        f"\nground_truth populated: {n_with_gt} (non-irrelevance) + {n_irrelevance} (irrelevance, gt=[] by design) = {n_with_gt + n_irrelevance}/{len(all_rows)}"
    )

    out_path = data_dir("raw") / "bfcl_v4.jsonl"
    n = save_jsonl(out_path, ({**r, "_source_id": "bfcl_v4"} for r in all_rows))
    print(f"\nsaved {n} BFCL rows -> {out_path}")

    # lockfile
    import yaml

    lockfile = data_dir("reports") / "lockfile.yaml"
    entries = {}
    if lockfile.exists():
        with open(lockfile) as f:
            entries = yaml.safe_load(f) or {}
    revision = None
    try:
        revision = api.dataset_info(REPO).sha
    except Exception:
        pass
    entries["bfcl_v4"] = {
        "repo": REPO,
        "config": None,
        "split": "raw_files",
        "revision": revision,
        "n_taken": n,
        "retrieved_utc": utc_now_iso(),
        "stratification": QUOTE,
    }
    with open(lockfile, "w") as f:
        yaml.safe_dump(entries, f, default_flow_style=False, sort_keys=True)


if __name__ == "__main__":
    main()
