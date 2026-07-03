#!/usr/bin/env python3
"""11 - Clone tau-bench da GitHub e materializza retail+airline tasks a JSONL.

Output: data/raw/tau_bench.jsonl (max ~165 task: ~115 retail + ~50 airline)
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from brick_evals.io_utils import data_dir, save_jsonl, utc_now_iso

GIT_URL = "https://github.com/sierra-research/tau-bench"
SEED = 42


def clone_repo(target: Path) -> str | None:
    """Clone (o pull) repo. Ritorna git commit hash."""
    if target.exists() and (target / ".git").exists():
        subprocess.run(["git", "-C", str(target), "fetch", "--tags"], check=False, capture_output=True)
    else:
        target.parent.mkdir(parents=True, exist_ok=True)
        r = subprocess.run(
            ["git", "clone", "--depth", "1", GIT_URL, str(target)],
            capture_output=True,
            text=True,
        )
        if r.returncode != 0:
            print(f"clone failed: {r.stderr}")
            return None
    r = subprocess.run(["git", "-C", str(target), "rev-parse", "HEAD"], capture_output=True, text=True)
    return r.stdout.strip() if r.returncode == 0 else None


def extract_tasks(repo_root: Path, domain: str) -> list[dict]:
    """Importa tau_bench.envs.<domain>.tasks come Python module e materializza tasks."""
    sys.path.insert(0, str(repo_root))
    try:
        try:
            mod = __import__(f"tau_bench.envs.{domain}.tasks", fromlist=["tasks"])
        except ImportError:
            mod = __import__(f"tau_bench.envs.{domain}.tasks_test", fromlist=["TASKS_TEST"])
        candidates = ["TASKS", "TASKS_TEST", "tasks"]
        tasks = None
        for name in candidates:
            if hasattr(mod, name):
                tasks = getattr(mod, name)
                break
        if tasks is None:
            print(f"  [warn] no TASKS/TASKS_TEST in {domain} module")
            return []
        out = []
        for i, t in enumerate(tasks):
            if hasattr(t, "model_dump"):
                d = t.model_dump()
            elif hasattr(t, "__dict__"):
                d = {k: v for k, v in t.__dict__.items() if not k.startswith("_")}
            elif isinstance(t, dict):
                d = t
            else:
                d = {"raw": str(t)}
            d["_domain"] = domain
            d["_index"] = i
            # Estrai 'instruction' se presente
            if "user_id" in d and "instruction" in d:
                pass
            elif "instruction" not in d and "instruction_text" in d:
                d["instruction"] = d.get("instruction_text")
            out.append(d)
        return out
    finally:
        try:
            sys.path.remove(str(repo_root))
        except ValueError:
            pass


def serialize_safe(obj):
    """Serialize-safe (handles non-JSON dataclass etc.)."""
    try:
        return json.loads(json.dumps(obj, default=str))
    except Exception:
        return str(obj)


def main():
    repo_dir = data_dir("..", "external") / "tau-bench"
    print(f"cloning to {repo_dir}...")
    sha = clone_repo(repo_dir)
    print(f"git HEAD: {sha}")

    # Install dependencies (best-effort)
    print("installing tau-bench package...")
    subprocess.run([sys.executable, "-m", "pip", "install", "-e", str(repo_dir), "-q"], check=False)

    all_tasks = []
    for domain in ["retail", "airline"]:
        print(f"\nextracting {domain} tasks...")
        tasks = extract_tasks(repo_dir, domain)
        print(f"  {len(tasks)} tasks found")
        all_tasks.extend(tasks)

    # Output JSONL
    cleaned = [serialize_safe(t) for t in all_tasks]
    for t in cleaned:
        t["_source_id"] = "tau_bench"

    out_path = data_dir("raw") / "tau_bench.jsonl"
    n = save_jsonl(out_path, cleaned)
    print(f"\nsaved {n} tau-bench rows -> {out_path}")

    # Lockfile
    import yaml

    lockfile = data_dir("reports") / "lockfile.yaml"
    entries = {}
    if lockfile.exists():
        with open(lockfile) as f:
            entries = yaml.safe_load(f) or {}
    entries["tau_bench"] = {
        "repo": GIT_URL,
        "github_sha": sha,
        "domains": ["retail", "airline"],
        "n_taken": n,
        "retrieved_utc": utc_now_iso(),
    }
    with open(lockfile, "w") as f:
        yaml.safe_dump(entries, f, default_flow_style=False, sort_keys=True)


if __name__ == "__main__":
    main()
