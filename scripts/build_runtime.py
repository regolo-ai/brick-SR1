#!/usr/bin/env python3
"""Build a CPU runtime bundle on the target machine, using source lockfiles."""

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
    crate = ROOT / "apps/router/candle-binding"
    router = ROOT / "apps/router/src/spatial-router"
    destination = ROOT / "dist" / f"runtime-{system}-{arch}"
    if destination.exists():
        raise SystemExit(f"Build output already exists: {destination}; move it before rebuilding")
    destination.parent.mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".runtime-", dir=destination.parent) as temp:
        bundle = Path(temp)
        binary_dir = bundle / "bin"
        binary_dir.mkdir()
        run("cargo", "build", "--locked", "--release", "--no-default-features", cwd=crate)
        extension = "so" if system == "linux" else "dylib"
        library_name = f"libcandle_spatial_router.{extension}"
        target = Path(os.environ.get("CARGO_TARGET_DIR", str(crate / "target"))).resolve()
        shutil.copy2(target / "release" / library_name, binary_dir / library_name)
        env = dict(os.environ)
        # Set a relative runtime search path, so deployment does not depend on
        # the build directory or a globally configured loader environment.
        env["CGO_ENABLED"] = "1"
        env["CGO_LDFLAGS"] = f"-L{target / 'release'} " + (
            "-Wl,-rpath,$ORIGIN" if system == "linux" else "-Wl,-rpath,@loader_path"
        )
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
        if system == "darwin":
            run("install_name_tool", "-id", f"@rpath/{library_name}", str(binary_dir / library_name))
            dependencies = subprocess.check_output(["otool", "-L", str(executable)], text=True)
            for line in dependencies.splitlines()[1:]:
                dependency = line.strip().split(" ")[0]
                if dependency.endswith(library_name):
                    run("install_name_tool", "-change", dependency, f"@rpath/{library_name}", str(executable))
        else:
            for artifact in [executable, binary_dir / library_name]:
                dependencies = subprocess.check_output(["ldd", str(artifact)], text=True)
                if "not found" in dependencies:
                    raise SystemExit(f"Unresolved native dependencies:\n{dependencies}")
            symbols = subprocess.check_output(["nm", "-D", "--defined-only", str(binary_dir / library_name)], text=True)
            exported = {line.split()[-1] for line in symbols.splitlines() if line.strip()}
            if exported != {"brick_model_load", "brick_classify"}:
                raise SystemExit(f"Unexpected C ABI exports: {exported}")
        collect(ROOT, bundle / "THIRD_PARTY_LICENSES.txt")
        (bundle / "package.json").write_text(
            json.dumps(
                {
                    "name": f"@regoloai/brick-runtime-{system}-{arch}",
                    "version": version,
                    "description": "Brick CPU runtime",
                    "license": "Apache-2.0",
                    "os": [system],
                    "cpu": [arch],
                    "files": ["bin", "LICENSE", "NOTICE", "THIRD_PARTY_NOTICES.md", "THIRD_PARTY_LICENSES.txt"],
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
