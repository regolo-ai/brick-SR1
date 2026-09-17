#!/usr/bin/env python3
"""Validate the contents, versions, and portability of Brick npm tarballs."""

from __future__ import annotations

import json
import os
import platform
import re
import subprocess
import sys
import tarfile
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CLI_NAME = "@regoloai/brick"
TARGETS = {
    "linux-x64": ("linux", "x64", b"$ORIGIN"),
    "linux-arm64": ("linux", "arm64", b"$ORIGIN"),
    "darwin-x64": ("darwin", "x64", b"@loader_path"),
    "darwin-arm64": ("darwin", "arm64", b"@loader_path"),
}
EXPECTED_COMMANDS = {
    "start",
    "stop",
    "restart",
    "clear",
    "status",
    "logs",
    "update",
    "uninstall",
    "profile",
    "chat",
    "generate",
    "route",
}


def fail(message: str) -> None:
    raise ValueError(message)


def member_json(archive: tarfile.TarFile, name: str) -> dict:
    member = archive.extractfile(name)
    if member is None:
        fail(f"Missing required package file: {name}")
    return json.load(member)


def repository_version(root: Path) -> str:
    cli = json.loads((root / "apps/cli/package.json").read_text())
    lock = json.loads((root / "package-lock.json").read_text())
    locked = lock.get("packages", {}).get("apps/cli", {}).get("version")
    if locked != cli.get("version"):
        fail(f"CLI package and lockfile versions differ: {cli.get('version')!r} != {locked!r}")
    return cli["version"]


def validate_filename(path: Path, package: dict) -> None:
    name = package.get("name", "")
    version = package.get("version", "")
    stem = name.removeprefix("@").replace("/", "-")
    expected = f"{stem}-{version}.tgz"
    if path.name != expected:
        fail(f"Tarball filename does not match its manifest: expected {expected}, got {path.name}")


def validate_runtime_manifest(manifest: dict, target: str, version: str) -> None:
    system, arch, _ = TARGETS[target]
    expected_name = f"@regoloai/brick-runtime-{target}"
    if manifest.get("name") != expected_name:
        fail(f"Runtime name for {target} must be {expected_name}")
    if manifest.get("version") != version:
        fail(f"Runtime {target} version {manifest.get('version')!r} does not match CLI {version!r}")
    if manifest.get("os") != [system] or manifest.get("cpu") != [arch]:
        fail(f"Runtime {target} platform fields do not match its package name")


def native_target() -> str | None:
    system = {"Linux": "linux", "Darwin": "darwin"}.get(platform.system())
    arch = {"x86_64": "x64", "aarch64": "arm64", "arm64": "arm64"}.get(platform.machine())
    return f"{system}-{arch}" if system and arch else None


def validate_loader_path(binary: bytes, target: str) -> None:
    marker = TARGETS[target][2]
    if marker not in binary:
        fail(f"Runtime {target} does not contain the required relative loader path {marker.decode()}")
    forbidden = (b"/app:", b"/app/", b"/home/runner/work/", b"/private/var/folders/")
    if any(value in binary for value in forbidden):
        fail(f"Runtime {target} contains an absolute build or deployment path")


def execute_version(archive: tarfile.TarFile, binary_name: str, version: str) -> None:
    with tempfile.TemporaryDirectory() as temporary:
        archive.extractall(temporary, filter="data")
        binary = Path(temporary) / binary_name
        binary.chmod(0o755)
        clean_env = dict(os.environ)
        for key in ("LD_LIBRARY_PATH", "DYLD_LIBRARY_PATH", "DYLD_FALLBACK_LIBRARY_PATH"):
            clean_env.pop(key, None)
        reported = subprocess.check_output(
            [str(binary), "--version"], env=clean_env, text=True, stderr=subprocess.STDOUT
        ).strip()
        if reported != version:
            fail(f"{binary_name} reports {reported!r}, expected {version!r}")


def validate_runtime(archive: tarfile.TarFile, prefix: str, target: str, version: str, execute: bool) -> None:
    manifest = member_json(archive, f"{prefix}package.json")
    validate_runtime_manifest(manifest, target, version)
    binary_name = f"{prefix}bin/brick-runtime"
    member = archive.extractfile(binary_name)
    if member is None:
        fail(f"Runtime {target} is missing bin/brick-runtime")
    validate_loader_path(member.read(), target)
    if execute and target == native_target():
        execute_version(archive, binary_name, version)


def validate_cli(
    archive: tarfile.TarFile,
    names: list[str],
    version: str,
    execute: bool,
    allow_partial_runtimes: bool,
) -> None:
    for name in names:
        if name.startswith("package/dist/commands/") and name.endswith(".js"):
            command = name.removeprefix("package/dist/commands/").split("/")[0].removesuffix(".js")
            if command not in EXPECTED_COMMANDS:
                fail(f"Unsupported published command: {name}")
    manifest = member_json(archive, "package/oclif.manifest.json")
    for command in manifest["commands"]:
        if command.split(":")[0] not in EXPECTED_COMMANDS:
            fail(f"Unsupported manifest command: {command}")
    if any("assets/models/" in name for name in names):
        fail("Model weights must be verified by postinstall, not packed from a developer cache")
    packaged_targets = {target for target in TARGETS if f"package/runtimes/{target}/package.json" in names}
    if not packaged_targets:
        fail("CLI package does not contain any native runtime")
    if not allow_partial_runtimes and packaged_targets != set(TARGETS):
        missing = ", ".join(sorted(set(TARGETS) - packaged_targets))
        fail(f"Universal CLI package is missing runtimes: {missing}")
    for target in packaged_targets:
        validate_runtime(archive, f"package/runtimes/{target}/", target, version, execute)


def validate_archives(
    paths: list[Path],
    root: Path = ROOT,
    execute: bool = True,
    allow_partial_runtimes: bool = False,
) -> None:
    expected_version = repository_version(root)
    if not paths:
        fail("At least one npm tarball is required")
    for path in paths:
        with tarfile.open(path) as archive:
            names = archive.getnames()
            for name in names:
                if re.search(
                    r"(^|/)(node_modules|target|__pycache__|\.git|\.env|tests?|plans|\.brick-internal)(/|$)|\.(test|spec)\.[cm]?[jt]sx?$|\.tsbuildinfo$",
                    name,
                ):
                    fail(f"Unexpected packaged development/private file: {name}")
            package = member_json(archive, "package/package.json")
            validate_filename(path, package)
            version = package.get("version")
            if version != expected_version:
                fail(f"Tarball version {version!r} does not match repository version {expected_version!r}")
            if package.get("name") == CLI_NAME:
                validate_cli(archive, names, version, execute, allow_partial_runtimes)
            elif package.get("name", "").startswith("@regoloai/brick-runtime-"):
                target = package["name"].removeprefix("@regoloai/brick-runtime-")
                if target not in TARGETS:
                    fail(f"Unsupported runtime target: {target}")
                validate_runtime(archive, "package/", target, version, execute)
            else:
                fail(f"Unexpected package name: {package.get('name')!r}")
            print(f"{path.name}: {len(names)} allowed files")


def main() -> None:
    try:
        arguments = sys.argv[1:]
        allow_partial = "--allow-partial-runtimes" in arguments
        paths = [Path(argument) for argument in arguments if not argument.startswith("--")]
        validate_archives(paths, allow_partial_runtimes=allow_partial)
    except (KeyError, OSError, subprocess.SubprocessError, tarfile.TarError, ValueError) as error:
        raise SystemExit(str(error)) from error


if __name__ == "__main__":
    main()
