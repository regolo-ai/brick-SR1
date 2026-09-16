"""I/O utilities: JSONL read/write, deterministic hashing, HF auth, lockfile helpers."""

from __future__ import annotations

import hashlib
import json
import os
from collections.abc import Iterable, Iterator
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


def deterministic_hash(obj: Any, length: int = 16) -> str:
    """SHA256 deterministico cross-platform su qualunque oggetto serializzabile JSON."""
    payload = json.dumps(obj, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(payload).hexdigest()[:length]


def file_sha256(path: str | Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(8192), b""):
            h.update(chunk)
    return h.hexdigest()


def save_jsonl(path: str | Path, rows: Iterable[dict]) -> int:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    n = 0
    with open(path, "w", encoding="utf-8") as f:
        for row in rows:
            f.write(json.dumps(row, ensure_ascii=False, separators=(",", ":")) + "\n")
            n += 1
    return n


def load_jsonl(path: str | Path) -> Iterator[dict]:
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                yield json.loads(line)


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def hf_token() -> str:
    """Read the Hub token from the environment or supported token file."""
    if env := os.environ.get("HF_TOKEN"):
        return env.strip()
    token_file = os.environ.get("HF_TOKEN_FILE", str(Path.home() / ".hf_token_regolo"))
    if Path(token_file).exists():
        return Path(token_file).read_text().strip()
    raise RuntimeError(f"HF token not found in env HF_TOKEN nor file {token_file}")


def _load_dotenv_once() -> None:
    """Load the repository .env once without overriding existing environment values."""
    if getattr(_load_dotenv_once, "_done", False):
        return
    try:
        from dotenv import load_dotenv
    except ImportError:
        _load_dotenv_once._done = True  # type: ignore[attr-defined]
        return
    env_path = repo_root() / ".env"
    if env_path.exists():
        load_dotenv(env_path, override=False)
    _load_dotenv_once._done = True  # type: ignore[attr-defined]


def openrouter_key() -> str:
    """Read OpenRouter credentials from environment, .env or the supported fallback file."""
    _load_dotenv_once()
    for var in ("OPENROUTER_API_KEY", "OPENROUTER_KEY"):
        if v := os.environ.get(var):
            return v.strip().strip('"').strip("'")
    key_file = os.environ.get("OPENROUTER_KEY_FILE", str(Path.home() / ".openrouter_key"))
    if Path(key_file).exists():
        return Path(key_file).read_text().strip().strip('"').strip("'")
    raise RuntimeError(f"OpenRouter key not found. Set OPENROUTER_API_KEY in env / .env, or place key in {key_file}.")


def regolo_synthetic_key() -> str:
    """Read the Regolo credential used by generation and judge tools."""
    key_file = os.environ.get("REGOLO_SYNTHETIC_KEY_FILE", str(Path.home() / ".regolo_synthetic_key"))
    if Path(key_file).exists():
        return Path(key_file).read_text().strip()
    if env := os.environ.get("REGOLO_API_KEY"):
        return env.strip()
    raise RuntimeError(f"Regolo synthetic key not found in {key_file} nor REGOLO_API_KEY env")


def repo_root() -> Path:
    return Path(__file__).resolve().parents[2]


def data_dir(*parts: str) -> Path:
    p = repo_root() / "data" / Path(*parts) if parts else repo_root() / "data"
    p.mkdir(parents=True, exist_ok=True)
    return p


def configs_dir() -> Path:
    return repo_root() / "configs"


def load_yaml(path: str | Path) -> dict:
    import yaml

    with open(path, encoding="utf-8") as f:
        return yaml.safe_load(f)
