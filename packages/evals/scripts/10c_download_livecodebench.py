#!/usr/bin/env python3
"""10c - Download LiveCodeBench v6 via hf_hub_download (datasets script deprecated in datasets>=4.0).

Strategia:
1. Lista i file del repo `livecodebench/code_generation_lite`.
2. Identifica i parquet/jsonl files che contengono i problemi.
3. Filtra `release_version == 'release_v6'` o `contest_date >= 2024-08-01`.
4. Sample 1000 con seed=42.
"""

from __future__ import annotations

import json
import random
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from brick_evals.io_utils import data_dir, hf_token, save_jsonl, utc_now_iso

REPO = "livecodebench/code_generation_lite"
TARGET_N = 1000
SEED = 42


def main():
    from huggingface_hub import HfApi, hf_hub_download

    api = HfApi(token=hf_token())
    files = api.list_repo_files(repo_id=REPO, repo_type="dataset")
    print(f"repo has {len(files)} files")

    parquet_files = [f for f in files if f.endswith(".parquet") or f.endswith(".jsonl")]
    print(f"data files: {parquet_files}")

    all_rows: list[dict] = []
    for fname in parquet_files:
        try:
            local = hf_hub_download(repo_id=REPO, filename=fname, repo_type="dataset", token=hf_token())
            print(f"  loaded {fname} -> {local}")
            if fname.endswith(".parquet"):
                import pyarrow.parquet as pq

                t = pq.read_table(local)
                rows = t.to_pylist()
            else:
                rows = []
                with open(local, encoding="utf-8") as f:
                    for line in f:
                        line = line.strip()
                        if line:
                            rows.append(json.loads(line))
            print(f"    {len(rows)} rows")
            all_rows.extend(rows)
        except Exception as e:
            print(f"  [warn] {fname}: {type(e).__name__}: {str(e)[:120]}")

    if not all_rows:
        print("[FAIL] no rows loaded from livecodebench")
        return 1

    print(f"\ntotal raw: {len(all_rows)}")
    if all_rows:
        print(f"sample fields: {list(all_rows[0].keys())[:10]}")

    # Filter release_v6 (or fallback) - se troppo pochi, allarga
    v6 = [r for r in all_rows if r.get("release_version") == "release_v6"]
    if len(v6) < TARGET_N:
        print(f"  release_v6 has {len(v6)} rows < target {TARGET_N}; trying contest_date >= 2024-08-01")
        v6 = [r for r in all_rows if str(r.get("contest_date", ""))[:10] >= "2024-08-01"]
    if len(v6) < TARGET_N:
        print(f"  contest_date filter has {len(v6)} rows; using ALL rows (contamination_risk -> medium)")
        v6 = all_rows
    print(f"final pool: {len(v6)} rows")

    rng = random.Random(SEED)
    sample = rng.sample(v6, min(TARGET_N, len(v6)))

    out_path = data_dir("raw") / "livecodebench_v6.jsonl"
    n = save_jsonl(out_path, ({**r, "_source_id": "livecodebench_v6"} for r in sample))
    print(f"saved {n} rows -> {out_path}")

    # Lockfile
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
    entries["livecodebench_v6"] = {
        "repo": REPO,
        "revision": revision,
        "n_taken": n,
        "retrieved_utc": utc_now_iso(),
        "filter": "release_v6 (or contest_date>=2024-08-01)",
    }
    with open(lockfile, "w") as f:
        yaml.safe_dump(entries, f, default_flow_style=False, sort_keys=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
