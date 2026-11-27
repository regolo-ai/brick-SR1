#!/usr/bin/env python3
"""Build the Go runtime; SystemOne uses an external Python/PyTorch environment."""

import argparse
import json
import os
import platform
import shutil
import subprocess
import tempfile
from pathlib import Path

from native_licenses import collect

ROOT = Path(__file__).resolve().parents[1]


def run(*args: str, cwd: Path = ROOT, env: dict | None = None) -> None:
    subprocess.run(args, cwd=cwd, env=env, check=True)


def main() -> None:
    system = {"Linux": "linux", "Darwin": "darwin"}.get(platform.system())
    arch = {"x86_64": "x64", "aarch64": "arm64", "arm64": "arm64"}.get(platform.machine())
    if not system or not arch:
        raise SystemExit("Runtime builds require Linux/macOS on x64/arm64")
    version = json.loads((ROOT / "apps/cli/package.json").read_text())["version"]
    router = ROOT / "apps/router/src/spatial-router"
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, help="Build into a separate local output directory")
    args = parser.parse_args()
    destination = args.output or ROOT / "dist" / f"runtime-{system}-{arch}"
    if destination.exists():
        raise SystemExit(f"Build output already exists: {destination}; move it before rebuilding")
    destination.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".runtime-", dir=destination.parent) as temp:
        bundle = Path(temp)
        binary_dir = bundle / "bin"
        binary_dir.mkdir()
        env = dict(os.environ)
        env["CGO_ENABLED"] = "0"
        env["GOFLAGS"] = "-mod=readonly"
        executable = binary_dir / "brick-runtime"
        run(
            "go",
            "build",
            "-trimpath",
            "-ldflags",
            f"-X main.version={version}",
            "-o",
            str(executable),
            "./cmd",
            cwd=router,
            env=env,
        )
        shutil.copy2(ROOT / "apps/router/systemone/requirements.txt", bundle / "requirements.txt")
        collect(ROOT, bundle / "THIRD_PARTY_LICENSES.txt")
        (bundle / "package.json").write_text(
            json.dumps(
                {
                    "name": f"@regoloai/brick-runtime-{system}-{arch}",
                    "version": version,
                    "description": "Brick Go runtime with local PyTorch SystemOne inference",
                    "inference_engine": "pytorch-transformers",
                    "license": "Apache-2.0",
                    "os": [system],
                    "cpu": [arch],
                    "files": [
                        "bin",
                        "requirements.txt",
                        "LICENSE",
                        "NOTICE",
                        "THIRD_PARTY_NOTICES.md",
                        "THIRD_PARTY_LICENSES.txt",
                    ],
                    "publishConfig": {"access": "public"},
                },
                indent=2,
            )
            + "\n"
        )
        for name in ["LICENSE", "NOTICE", "THIRD_PARTY_NOTICES.md"]:
            shutil.copy2(ROOT / name, bundle / name)
        # Exercise the loader with no development library search path.
        clean_env = dict(os.environ)
        for key in ["LD_LIBRARY_PATH", "DYLD_LIBRARY_PATH", "DYLD_FALLBACK_LIBRARY_PATH"]:
            clean_env.pop(key, None)
        run(str(executable), "--help", cwd=bundle, env=clean_env)
        reported = subprocess.check_output([str(executable), "--version"], env=clean_env, text=True).strip()
        if reported != version:
            raise SystemExit(f"Runtime version output does not match package version: {reported!r}")
        bundle.rename(destination)
    print(destination)


if __name__ == "__main__":
    main()
