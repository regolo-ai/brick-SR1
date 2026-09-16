#!/usr/bin/env python3
"""Download and verify the pinned capability model for source development.

End users receive these same assets through npm postinstall. Complexity and
provider inference use APIs; this command installs no Python runtime server.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import tempfile
import urllib.request
from pathlib import Path


def verify(directory: Path, files: dict) -> None:
    for name, expected in files.items():
        path = directory / name
        digest = hashlib.sha256()
        with path.open("rb") as stream:
            while chunk := stream.read(1024 * 1024):
                digest.update(chunk)
        if path.stat().st_size != expected["bytes"] or digest.hexdigest() != expected["sha256"]:
            raise ValueError(f"Incomplete or corrupt model asset: {name}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, default=Path("./models"))
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[3]
    manifest = json.loads((root / "apps/cli/assets/modernbert.json").read_text())
    target = args.out.resolve() / "modernbert-capability-classifier"
    if target.exists():
        verify(target, manifest["files"])
    else:
        args.out.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(prefix=".download-", dir=args.out) as temp:
            directory = Path(temp)
            for name in manifest["files"]:
                url = f"https://huggingface.co/{manifest['repository']}/resolve/{manifest['revision']}/{name}"
                with urllib.request.urlopen(url, timeout=60) as response, (directory / name).open("wb") as out:
                    while chunk := response.read(1024 * 1024):
                        out.write(chunk)
            verify(directory, manifest["files"])
            directory.rename(target)
    print(target)


if __name__ == "__main__":
    main()
