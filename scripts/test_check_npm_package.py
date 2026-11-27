import io
import json
import tarfile
from pathlib import Path

import pytest
from check_npm_package import TARGETS, validate_archives

VERSION = "3.0.2"


def add(archive: tarfile.TarFile, name: str, contents: bytes) -> None:
    info = tarfile.TarInfo(name)
    info.size = len(contents)
    info.mode = 0o755 if name.endswith("brick-runtime") else 0o644
    archive.addfile(info, io.BytesIO(contents))


def project(tmp_path: Path, locked: str = VERSION) -> Path:
    root = tmp_path / "root"
    (root / "apps/cli").mkdir(parents=True)
    (root / "apps/cli/package.json").write_text(json.dumps({"version": VERSION}))
    (root / "package-lock.json").write_text(json.dumps({"packages": {"apps/cli": {"version": locked}}}))
    return root


def cli_tarball(tmp_path: Path, runtime_version: str = VERSION) -> Path:
    path = tmp_path / f"regoloai-brick-{VERSION}.tgz"
    with tarfile.open(path, "w:gz") as archive:
        add(archive, "package/package.json", json.dumps({"name": "@regoloai/brick", "version": VERSION}).encode())
        add(archive, "package/oclif.manifest.json", b'{"commands":["start"]}')
        for target, (system, arch) in TARGETS.items():
            prefix = f"package/runtimes/{target}/"
            manifest = {
                "name": f"@regoloai/brick-runtime-{target}",
                "version": runtime_version,
                "os": [system],
                "cpu": [arch],
                "inference_engine": "pytorch-transformers",
            }
            add(archive, prefix + "package.json", json.dumps(manifest).encode())
            add(archive, prefix + "bin/brick-runtime", b"static Go runtime")
            add(archive, prefix + "requirements.txt", b"torch>=2.2\ntransformers==5.16.1\n")
    return path


def test_accepts_aligned_universal_package(tmp_path: Path) -> None:
    validate_archives([cli_tarball(tmp_path)], project(tmp_path), execute=False)


def test_rejects_lockfile_mismatch(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="lockfile versions differ"):
        validate_archives([cli_tarball(tmp_path)], project(tmp_path, "3.0.1"), execute=False)


def test_rejects_runtime_version_mismatch(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="does not match CLI"):
        validate_archives([cli_tarball(tmp_path, "3.0.1")], project(tmp_path), execute=False)


def test_rejects_filename_mismatch(tmp_path: Path) -> None:
    path = cli_tarball(tmp_path)
    wrong = path.with_name("regoloai-brick-3.0.1.tgz")
    path.rename(wrong)
    with pytest.raises(ValueError, match="filename does not match"):
        validate_archives([wrong], project(tmp_path), execute=False)


def test_rejects_absolute_runtime_build_path(tmp_path: Path) -> None:
    path = cli_tarball(tmp_path)
    replacement = tmp_path / "replacement.tgz"
    with tarfile.open(path) as source, tarfile.open(replacement, "w:gz") as destination:
        for member in source.getmembers():
            contents = source.extractfile(member).read() if member.isfile() else b""
            if member.name == "package/runtimes/linux-x64/bin/brick-runtime":
                contents = b"$ORIGIN /app:/app/models"
                member.size = len(contents)
            destination.addfile(member, io.BytesIO(contents) if member.isfile() else None)
    replacement.replace(path)
    with pytest.raises(ValueError, match="absolute build or deployment path"):
        validate_archives([path], project(tmp_path), execute=False)


def test_rejects_incomplete_universal_package(tmp_path: Path) -> None:
    path = cli_tarball(tmp_path)
    replacement = tmp_path / "replacement.tgz"
    with tarfile.open(path) as source, tarfile.open(replacement, "w:gz") as destination:
        for member in source.getmembers():
            if "/runtimes/darwin-arm64/" in member.name:
                continue
            contents = source.extractfile(member).read() if member.isfile() else b""
            destination.addfile(member, io.BytesIO(contents) if member.isfile() else None)
    replacement.replace(path)
    with pytest.raises(ValueError, match="missing runtimes: darwin-arm64"):
        validate_archives([path], project(tmp_path), execute=False)
    validate_archives([path], project(tmp_path / "partial"), execute=False, allow_partial_runtimes=True)


def test_pytorch_runtime_requires_dependency_manifest(tmp_path: Path) -> None:
    from check_npm_package import validate_runtime

    def bundle(include_requirements):
        data = io.BytesIO()
        with tarfile.open(fileobj=data, mode="w") as archive:
            add(
                archive,
                "package/package.json",
                json.dumps(
                    {
                        "name": "@regoloai/brick-runtime-linux-x64",
                        "version": VERSION,
                        "os": ["linux"],
                        "cpu": ["x64"],
                        "inference_engine": "pytorch-transformers",
                    }
                ).encode(),
            )
            add(archive, "package/bin/brick-runtime", b"static Go binary")
            if include_requirements:
                add(archive, "package/requirements.txt", b"torch>=2.2\ntransformers==5.16.1\n")
        data.seek(0)
        return tarfile.open(fileobj=data)

    with bundle(True) as archive:
        validate_runtime(archive, "package/", "linux-x64", VERSION, execute=False)
    with bundle(False) as archive, pytest.raises(ValueError, match="missing requirements.txt"):
        validate_runtime(archive, "package/", "linux-x64", VERSION, execute=False)
