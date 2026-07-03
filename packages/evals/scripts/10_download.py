#!/usr/bin/env python3
"""10 - Download HF datasets (parametrizzato).

Usage:
    python 10_download.py <source_id>
    python 10_download.py --all          # download tutti i source HF
    python 10_download.py --list

Salva data/raw/<source_id>.jsonl con campi nativi + commit hash in data/reports/lockfile.yaml.
"""

from __future__ import annotations

import argparse
import random
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from brick_evals.io_utils import (
    configs_dir,
    data_dir,
    hf_token,
    load_yaml,
    save_jsonl,
    utc_now_iso,
)


def _filter_rows(rows: list[dict], filt: dict | None) -> list[dict]:
    if not filt:
        return rows
    if "field" in filt and ("value" in filt or "values" in filt):
        f = filt["field"]
        if "values" in filt:
            allowed = set(filt["values"])
            out = [r for r in rows if r.get(f) in allowed]
        else:
            v = filt["value"]
            out = [r for r in rows if r.get(f) == v]
        if not out and "fallback_field" in filt:
            ff = filt["fallback_field"]
            fmin = filt.get("fallback_min")
            out = [r for r in rows if str(r.get(ff, "")) >= str(fmin)]
        return out
    return rows


def _stratify_mmlu_pro_humanities(rows: list[dict], target_n: int, seed: int = 42) -> list[dict]:
    """MMLU-Pro: filtro humanities {history, philosophy, law}, stratify proporzionale."""
    cats = ["history", "philosophy", "law"]
    by_cat = {c: [r for r in rows if r.get("category") == c] for c in cats}
    totals = {c: len(v) for c, v in by_cat.items()}
    grand = sum(totals.values())
    if grand == 0:
        return []
    rng = random.Random(seed)
    out = []
    for c in cats:
        n_for_cat = round(target_n * totals[c] / grand)
        n_for_cat = min(n_for_cat, len(by_cat[c]))
        out.extend(rng.sample(by_cat[c], n_for_cat) if n_for_cat else [])
    # adjust se off di poco
    while len(out) < target_n and grand > len(out):
        for c in cats:
            if len(out) >= target_n:
                break
            remaining = [r for r in by_cat[c] if r not in out]
            if remaining:
                out.append(rng.choice(remaining))
    return out[:target_n]


def download_source(source_id: str, cfg: dict) -> int:
    from datasets import load_dataset
    from huggingface_hub import HfApi

    if cfg.get("custom_handler"):
        print(f"  [SKIP] {source_id}: custom_handler='{cfg['custom_handler']}' (run dedicated script)")
        return 0

    repo = cfg["repo"]
    configs_list = cfg.get("configs")  # multi-config support
    config = cfg.get("config")
    split = cfg.get("split", "test")
    target_n = cfg["target_n"]
    seed = 42

    api = HfApi(token=hf_token())
    revision = None
    try:
        revision = api.dataset_info(repo).sha
    except Exception as e:
        print(f"  [warn] could not fetch revision for {repo}: {e}")

    rows: list[dict] = []
    if configs_list:
        print(f"  loading {repo} multi-config {configs_list} split={split}...")
        for c in configs_list:
            kw = {"path": repo, "name": c, "split": split, "token": hf_token(), "trust_remote_code": False}
            try:
                ds = load_dataset(**kw)
                cfg_rows = [{**r, "_config": c} for r in ds]
                rows.extend(cfg_rows)
                print(f"    {c}: {len(cfg_rows)} rows")
            except Exception as e:
                print(f"    [warn] {c}: {type(e).__name__}: {str(e)[:120]}")
    else:
        print(f"  loading {repo} (config={config}, split={split})...")
        kw = {"path": repo, "split": split, "token": hf_token(), "trust_remote_code": False}
        if config is not None:
            kw["name"] = config
        try:
            ds = load_dataset(**kw)
        except TypeError:
            kw.pop("token", None)
            ds = load_dataset(**kw, use_auth_token=hf_token())
        rows = list(ds)

    # Filtri
    rows = _filter_rows(rows, cfg.get("filter"))

    # Sampling
    if source_id == "mmlu_pro_humanities":
        rows = _stratify_mmlu_pro_humanities(rows, target_n, seed=seed)
    elif len(rows) > target_n:
        rng = random.Random(seed)
        rows = rng.sample(rows, target_n)

    # Output
    out_path = data_dir("raw") / f"{source_id}.jsonl"
    n = save_jsonl(out_path, ({**r, "_source_id": source_id} for r in rows))

    # Lockfile entry append
    _append_lockfile(source_id, repo, config, split, revision, n)

    print(f"  saved {n} rows -> {out_path}")
    return n


def _append_lockfile(source_id, repo, config, split, revision, n_taken):
    lockfile = data_dir("reports") / "lockfile.yaml"
    entries = {}
    if lockfile.exists():
        try:
            entries = load_yaml(lockfile) or {}
        except Exception:
            entries = {}
    entries[source_id] = {
        "repo": repo,
        "config": config,
        "split": split,
        "revision": revision,
        "n_taken": n_taken,
        "retrieved_utc": utc_now_iso(),
    }
    import yaml

    with open(lockfile, "w") as f:
        yaml.safe_dump(entries, f, default_flow_style=False, sort_keys=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("source_id", nargs="?", help="source id from configs/sources.yaml")
    ap.add_argument("--all", action="store_true", help="download all HF sources")
    ap.add_argument("--list", action="store_true", help="list source ids")
    args = ap.parse_args()

    sources = load_yaml(configs_dir() / "sources.yaml")
    hf_sources = {
        sid: cfg
        for sid, cfg in sources.items()
        if not sid.startswith("_") and isinstance(cfg, dict) and cfg.get("repo")
    }

    if args.list:
        for sid in hf_sources:
            print(sid, "->", hf_sources[sid]["repo"])
        return 0

    if args.all:
        total = 0
        for sid, cfg in hf_sources.items():
            print(f"\n=== {sid} ===")
            try:
                total += download_source(sid, cfg)
            except Exception as e:
                print(f"  [FAIL] {sid}: {type(e).__name__}: {str(e)[:200]}")
        print(f"\n=== TOTAL: {total} rows downloaded ===")
        return 0

    if not args.source_id:
        ap.print_help()
        return 1

    cfg = hf_sources.get(args.source_id)
    if cfg is None:
        print(f"unknown source_id: {args.source_id}")
        print("available:", list(hf_sources))
        return 1
    download_source(args.source_id, cfg)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
