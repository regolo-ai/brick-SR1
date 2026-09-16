#!/usr/bin/env python3
"""Reject development files and unexpected CLI commands in actual npm tarballs."""

import json
import re
import sys
import tarfile
from pathlib import Path

expected = {
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
for argument in sys.argv[1:]:
    with tarfile.open(argument) as archive:
        names = archive.getnames()
        for name in names:
            if re.search(
                r"(^|/)(node_modules|target|__pycache__|\.git|\.env|tests?|plans|\.brick-internal)(/|$)|\.(test|spec)\.[cm]?[jt]sx?$|\.tsbuildinfo$",
                name,
            ):
                raise SystemExit(f"Unexpected packaged development/private file: {name}")
        package = json.load(archive.extractfile("package/package.json"))
        if package["name"] == "@regoloai/brick":
            for name in names:
                if name.startswith("package/dist/commands/") and name.endswith(".js"):
                    command = name.removeprefix("package/dist/commands/").split("/")[0].removesuffix(".js")
                    if command not in expected:
                        raise SystemExit(f"Unsupported published command: {name}")
            manifest = json.load(archive.extractfile("package/oclif.manifest.json"))
            for command in manifest["commands"]:
                if command.split(":")[0] not in expected:
                    raise SystemExit(f"Unsupported manifest command: {command}")
            if any("assets/models/" in name for name in names):
                raise SystemExit("Model weights must be verified by postinstall, not packed from a developer cache")
        print(f"{Path(argument).name}: {len(names)} allowed files")
