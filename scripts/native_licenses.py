"""Collect license texts from the locked Go runtime dependencies."""

import json
import subprocess
from pathlib import Path


def collect(root: Path, output: Path) -> None:
    entries = []
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
