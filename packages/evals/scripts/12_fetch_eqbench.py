#!/usr/bin/env python3
"""12 - Fetch EQ-Bench Creative Writing v3 prompts.

Tenta multiple sorgenti possibili:
1. Il manifest URL configurato in sources.yaml::eqbench_creative_v3.manifest_url
2. Repo HF candidati (Disya/eq-bench-creative-writing-v3, EQ-Bench/creative-writing-v3)
3. Static fallback (96 prompt da generation hardcoded; se tutti falliscono -> warn)

Output: data/raw/eqbench_creative_v3.jsonl (target 96 prompt)
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from brick_evals.io_utils import configs_dir, data_dir, hf_token, load_yaml, save_jsonl, utc_now_iso

TARGET_N = 96


def try_http_manifest(url: str) -> list[dict] | None:
    import requests

    try:
        r = requests.get(url, timeout=30)
        if r.status_code != 200:
            return None
        ct = r.headers.get("content-type", "")
        if "json" in ct or url.endswith(".json"):
            data = r.json()
        else:
            return None
        # Try to find prompt list
        prompts = []
        if isinstance(data, dict):
            # heuristic: look for keys 'prompts', 'questions', 'tasks'
            for k in ("prompts", "questions", "tasks", "items", "creative_writing_prompts"):
                if k in data and isinstance(data[k], list):
                    prompts = data[k]
                    break
            if not prompts:
                # iterate values searching for list of dicts with 'prompt' key
                for v in data.values():
                    if isinstance(v, list) and v and isinstance(v[0], dict) and "prompt" in v[0]:
                        prompts = v
                        break
        elif isinstance(data, list):
            prompts = data
        return prompts or None
    except Exception as e:
        print(f"  [warn] HTTP fetch failed {url}: {e}")
        return None


def try_hf_repo(repo_id: str) -> list[dict] | None:
    try:
        from datasets import load_dataset

        ds = load_dataset(repo_id, split="train", token=hf_token(), trust_remote_code=False)
        rows = list(ds)
        if rows and any(("prompt" in r) or ("writing_prompt" in r) or ("question" in r) for r in rows):
            return rows
        return None
    except Exception as e:
        print(f"  [warn] HF repo {repo_id} failed: {type(e).__name__}: {str(e)[:120]}")
        return None


def expand_iterations(rows: list[dict], target_n: int = 96) -> list[dict]:
    """Se source ha 24-32 prompt-base, espandi a 96 con 'iteration' field (1..3 o 1..4)."""
    if len(rows) >= target_n:
        return rows[:target_n]
    if len(rows) == 0:
        return []
    iters_per_prompt = max(1, target_n // len(rows))
    out = []
    for r in rows:
        for i in range(1, iters_per_prompt + 1):
            new_row = {
                **r,
                "iteration": i,
                "_base_id": r.get("id") or r.get("name") or hash(r.get("prompt") or r.get("question", "")),
            }
            out.append(new_row)
            if len(out) >= target_n:
                return out[:target_n]
    return out[:target_n]


def main():
    cfg = load_yaml(configs_dir() / "sources.yaml")["eqbench_creative_v3"]
    manifest_url = cfg.get("manifest_url", "")

    print(f"attempting manifest URL: {manifest_url}")
    rows = try_http_manifest(manifest_url) if manifest_url else None

    if not rows:
        for repo in (
            "Disya/eq-bench-creative-writing-v3",
            "EQ-Bench/creative-writing-v3",
            "EQ-Bench/eq-bench-v3-prompts",
        ):
            print(f"trying HF repo: {repo}")
            rows = try_hf_repo(repo)
            if rows:
                break

    if not rows:
        print("[FAIL] no source for EQ-Bench v3 prompts. Skipping (creative_synthesis dimension scenderà di 96).")
        # write empty file marker
        out_path = data_dir("raw") / "eqbench_creative_v3.jsonl"
        save_jsonl(out_path, [])
        return 1

    # Normalize prompt field naming
    norm = []
    for r in rows:
        prompt = r.get("prompt") or r.get("writing_prompt") or r.get("question") or r.get("text") or ""
        if prompt:
            norm.append({**r, "prompt": prompt})

    # Expand to 96 if needed (32 prompt-base x 3 iter)
    expanded = expand_iterations(norm, TARGET_N)

    out_path = data_dir("raw") / "eqbench_creative_v3.jsonl"
    n = save_jsonl(out_path, ({**r, "_source_id": "eqbench_creative_v3"} for r in expanded))
    print(f"saved {n} eqbench rows -> {out_path}")

    import yaml

    lockfile = data_dir("reports") / "lockfile.yaml"
    entries = {}
    if lockfile.exists():
        with open(lockfile) as f:
            entries = yaml.safe_load(f) or {}
    entries["eqbench_creative_v3"] = {
        "manifest_url": manifest_url,
        "n_taken": n,
        "retrieved_utc": utc_now_iso(),
    }
    with open(lockfile, "w") as f:
        yaml.safe_dump(entries, f, default_flow_style=False, sort_keys=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
