#!/usr/bin/env python3
"""Fetch pinned grader sources and checksum-verified language resources.

Existing checkouts must match their revision and be clean. User modifications
are never reset. This explicit developer setup performs all required downloads;
unit tests and grading do not download dependencies on demand.
"""

import hashlib
import json
import subprocess
import tempfile
import urllib.request
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
EXTERNAL = ROOT / "packages/evals/external"
SOURCES = [
    (
        "bfcl",
        "https://github.com/ShishirPatil/gorilla.git",
        "6ea57973c7a6097fd7c5915698c54c17c5b1b6c8",
        "berkeley-function-call-leaderboard",
    ),
    (
        "livecodebench",
        "https://github.com/LiveCodeBench/LiveCodeBench.git",
        "28fef95ea8c9f7a547c8329f2cd3d32b92c1fa24",
        "lcb_runner",
    ),
]


def git(directory: Path, *arguments: str) -> str:
    return subprocess.check_output(["git", "-C", str(directory), *arguments], text=True).strip()


def checkout_source(name: str, repository: str, revision: str, subtree: str) -> None:
    destination = EXTERNAL / name
    if destination.exists():
        if git(destination, "rev-parse", "HEAD") != revision:
            raise SystemExit(f"{destination} must use revision {revision}")
        if git(destination, "status", "--porcelain"):
            raise SystemExit(f"{destination} contains changes; leaving it untouched")
        return
    with tempfile.TemporaryDirectory(prefix=f".{name}-", dir=EXTERNAL) as temp:
        checkout = Path(temp) / "source"
        checkout.mkdir()
        git(checkout, "init", "--quiet")
        git(checkout, "remote", "add", "origin", repository)
        git(checkout, "sparse-checkout", "set", subtree)
        git(checkout, "fetch", "--depth=1", "--filter=blob:none", "origin", revision)
        git(checkout, "checkout", "--detach", "FETCH_HEAD")
        if git(checkout, "rev-parse", "HEAD") != revision:
            raise SystemExit(f"{name} revision verification failed")
        checkout.rename(destination)


def language_resources() -> None:
    manifest = json.loads((ROOT / "packages/evals/configs/nltk-assets.json").read_text())
    destination = EXTERNAL / "nltk_data"
    marker = destination / ".complete.json"
    if marker.exists() and json.loads(marker.read_text()) == manifest:
        return
    if destination.exists():
        raise SystemExit(f"Incomplete language resources: inspect and remove {destination} before retrying")
    with tempfile.TemporaryDirectory(prefix=".nltk-", dir=EXTERNAL) as temp:
        stage = Path(temp) / "data"
        stage.mkdir()
        for name, asset in manifest.items():
            with urllib.request.urlopen(asset["url"], timeout=120) as response:
                data = response.read(asset["bytes"] + 1)
            if len(data) != asset["bytes"] or hashlib.sha256(data).hexdigest() != asset["sha256"]:
                raise SystemExit(f"Language resource checksum failed: {name}")
            archive = Path(temp) / "download.zip"
            archive.write_bytes(data)
            parent = stage / Path(name).parent
            parent.mkdir(parents=True, exist_ok=True)
            with zipfile.ZipFile(archive) as source:
                for member in source.namelist():
                    if not (parent / member).resolve().is_relative_to(parent.resolve()):
                        raise SystemExit("Unsafe language resource archive path")
                source.extractall(parent)
        (stage / ".complete.json").write_text(json.dumps(manifest))
        stage.rename(destination)


def main() -> None:
    EXTERNAL.mkdir(parents=True, exist_ok=True)
    for source in SOURCES:
        checkout_source(*source)
    language_resources()


if __name__ == "__main__":
    main()
