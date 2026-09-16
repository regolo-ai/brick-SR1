"""Collect license texts from the exact locked native dependency sources."""

import json
import subprocess
from pathlib import Path


def collect(root: Path, output: Path) -> None:
    crate = root / "apps/router/candle-binding"
    host = next(
        line.split(": ", 1)[1]
        for line in subprocess.check_output(["rustc", "-vV"], text=True).splitlines()
        if line.startswith("host: ")
    )
    metadata = json.loads(
        subprocess.check_output(
            [
                "cargo",
                "metadata",
                "--locked",
                "--format-version",
                "1",
                "--no-default-features",
                "--filter-platform",
                host,
            ],
            cwd=crate,
            text=True,
        )
    )
    entries = []
    for package in metadata["packages"]:
        if package["source"] is not None:
            entries.append(
                (
                    package["name"] + " " + package["version"],
                    Path(package["manifest_path"]).parent,
                    package.get("license_file"),
                )
            )
    router = root / "apps/router/src/spatial-router"
    # Downloading these locked sources is a build operation, never postinstall.
    modules = subprocess.check_output(["go", "mod", "download", "-json"], cwd=router, text=True)
    decoder = json.JSONDecoder()
    while modules.strip():
        module, length = decoder.raw_decode(modules.lstrip())
        modules = modules.lstrip()[length:]
        if module.get("Error"):
            raise RuntimeError(module["Error"])
        if module.get("Dir"):
            entries.append((module["Path"] + " " + module["Version"], Path(module["Dir"]), None))
    sections = []
    missing = []
    for name, directory, declared_file in sorted(entries):
        files = [
            p
            for p in directory.iterdir()
            if p.is_file() and p.name.lower().startswith(("license", "licence", "copying", "notice"))
        ]
        if declared_file and (directory / declared_file).is_file():
            files.append(directory / declared_file)
        if not files:
            # Git workspace packages sometimes keep their license at repo root.
            for parent in list(directory.parents)[:3]:
                matches = [
                    p
                    for p in parent.iterdir()
                    if p.is_file() and p.name.lower().startswith(("license", "licence", "copying"))
                ]
                if matches:
                    files.extend(matches)
                    break
        if not files and name == "ug 0.5.0":
            files = list((root / "licenses/ug-0.5.0").glob("LICENSE-*"))
        if not files:
            missing.append(name)
            continue
        sections.append(
            name
            + "\n"
            + "=" * len(name)
            + "\n"
            + "\n".join(f"{p.name}\n{p.read_text(errors='replace')}" for p in sorted(set(files)))
        )
    if missing:
        raise RuntimeError("Missing native dependency license texts: " + ", ".join(missing))
    output.write_text("\n\n".join(sections))
