#!/usr/bin/env python3
"""00 - Setup check: HF token, gated dataset access, tokenizer mapping, BFCL/LiveCodeBench enumeration.

Esegue check non-distruttivi e segnala blocking issues prima di lanciare la pipeline.
"""

from __future__ import annotations

import sys
from pathlib import Path

# Add src to path for direct execution
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from brick_evals.io_utils import (
    configs_dir,
    hf_token,
    load_yaml,
    regolo_synthetic_key,
)


def check_hf_token() -> bool:
    try:
        tok = hf_token()
        print(f"  [OK] HF token loaded ({len(tok)} chars)")
        return True
    except Exception as e:
        print(f"  [FAIL] HF token: {e}")
        return False


def check_regolo_key() -> bool:
    try:
        key = regolo_synthetic_key()
        print(f"  [OK] Regolo synthetic key loaded ({len(key)} chars)")
        return True
    except Exception as e:
        print(f"  [WARN] Regolo synthetic key not available: {e}")
        print("         creative_custom_generate will be skipped (cap 0)")
        return False


def check_hf_repo(repo_id: str, *, gated_ok: bool = False) -> tuple[bool, str | None]:
    from huggingface_hub import HfApi
    from huggingface_hub.errors import GatedRepoError, RepositoryNotFoundError

    api = HfApi(token=hf_token())
    try:
        info = api.dataset_info(repo_id)
        return True, info.sha
    except GatedRepoError:
        if gated_ok:
            return True, "gated_no_access"
        return False, "gated_no_access"
    except RepositoryNotFoundError:
        return False, "not_found"
    except Exception as e:
        return False, f"error: {e}"


def check_tokenizer(alias: str, hf_id: str) -> bool:
    try:
        from transformers import AutoTokenizer

        tok = AutoTokenizer.from_pretrained(hf_id, use_fast=True, token=hf_token(), trust_remote_code=False)
        v = tok.encode("hello world", add_special_tokens=False)
        print(f"  [OK] tokenizer {alias} -> {hf_id} (sample 'hello world' -> {len(v)} tokens)")
        return True
    except Exception as e:
        print(f"  [WARN] tokenizer {alias} -> {hf_id} failed: {type(e).__name__}: {str(e)[:120]}")
        return False


def check_bfcl_repo() -> bool:
    """BFCL non e' load_dataset-able. Verifica via list_repo_files."""
    from huggingface_hub import HfApi

    api = HfApi(token=hf_token())
    try:
        files = api.list_repo_files(repo_id="gorilla-llm/Berkeley-Function-Calling-Leaderboard", repo_type="dataset")
        json_files = [f for f in files if f.endswith(".json")]
        print(f"  [OK] BFCL has {len(json_files)} .json files (sample: {json_files[:3]})")
        return True
    except Exception as e:
        print(f"  [FAIL] BFCL list_repo_files: {e}")
        return False


def check_taubench_github() -> bool:
    """Verifica che il repo GitHub tau-bench sia raggiungibile (HEAD request)."""
    import requests

    try:
        r = requests.head("https://github.com/sierra-research/tau-bench", timeout=10, allow_redirects=True)
        ok = r.status_code in (200, 301, 302)
        print(f"  [{'OK' if ok else 'FAIL'}] tau-bench GitHub repo reachable (status {r.status_code})")
        return ok
    except Exception as e:
        print(f"  [FAIL] tau-bench GitHub reach: {e}")
        return False


def check_eqbench_manifest() -> bool:
    """Verifica reachability del manifest eqbench.com."""
    import requests

    candidates = [
        "https://eqbench.com/results/creative-writing-v3.json",
        "https://eqbench.com/creative_writing.html",
        "https://eqbench.com/",
    ]
    for url in candidates:
        try:
            r = requests.head(url, timeout=10, allow_redirects=True)
            if r.status_code == 200:
                print(f"  [OK] eqbench.com reachable via {url}")
                return True
        except Exception:
            continue
    print("  [WARN] eqbench.com manifest URL TBD; aggiornare configs/sources.yaml::eqbench_creative_v3.manifest_url")
    return False


def check_regolo_models() -> bool:
    try:
        from brick_evals.regolo_client import RegoloClient

        client = RegoloClient()
        models = client.list_models()
        ids = [m.get("id") for m in models]
        target = "qwen3.5-122b"
        if target in ids:
            print(f"  [OK] Regolo: model '{target}' available")
        else:
            print(f"  [WARN] Regolo: model '{target}' not in list. Available: {ids[:10]}")
        return True
    except Exception as e:
        print(f"  [WARN] Regolo list_models failed: {type(e).__name__}: {str(e)[:120]}")
        return False


def main() -> int:
    print("=== 00_setup_check ===\n")
    failures = []

    print("[1] Auth tokens")
    if not check_hf_token():
        failures.append("hf_token")
    check_regolo_key()  # warn-only
    print()

    print("[2] HF dataset repos")
    sources = load_yaml(configs_dir() / "sources.yaml")
    for sid, cfg in sources.items():
        if sid.startswith("_"):
            continue
        if not isinstance(cfg, dict):
            continue
        repo = cfg.get("repo")
        if not repo:
            continue
        gated = cfg.get("gated", False)
        ok, info = check_hf_repo(repo, gated_ok=gated)
        marker = "OK" if ok else "FAIL"
        print(f"  [{marker}] {sid:30s} -> {repo} ({'gated' if gated else 'public'}, sha={info})")
        if not ok and not gated:
            failures.append(f"repo:{sid}")
    print()

    print("[3] Tokenizers (3 modelli pool)")
    models = load_yaml(configs_dir() / "models.yaml")
    for _key, cfg in models.items():
        if not isinstance(cfg, dict) or cfg.get("provider") == "regolo":
            continue
        if alias := cfg.get("alias"):
            if not check_tokenizer(alias, cfg["hf_tokenizer"]):
                # try fallback
                fb = cfg.get("hf_tokenizer_fallback")
                if fb:
                    check_tokenizer(f"{alias} (fallback)", fb)
                else:
                    failures.append(f"tokenizer:{alias}")
    print()

    print("[4] Special sources")
    if not check_bfcl_repo():
        failures.append("bfcl")
    check_taubench_github()
    check_eqbench_manifest()
    check_regolo_models()
    print()

    print("=== Summary ===")
    if failures:
        print(f"  FAILURES ({len(failures)}): {failures}")
        return 1
    print("  All blocking checks passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
