#!/usr/bin/env python3
"""Install real tarballs with only Node/npm/sh visible, as an ordinary user."""

import argparse
import os
import pwd
import shutil
import subprocess
import tempfile
from pathlib import Path

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("tarballs", nargs="+", type=Path)
args = parser.parse_args()
root = Path(tempfile.mkdtemp(prefix="brick-install-linux-"))
for name in ["bin", "cache", "installed", "profiles", "tarballs"]:
    (root / name).mkdir()
for name in ["node", "npm", "sh"]:
    source = shutil.which(name)
    if not source:
        raise SystemExit(f"Required acceptance-test tool missing: {name}")
    (root / "bin" / name).symlink_to(Path(source).resolve())
for source in args.tarballs:
    shutil.copy2(source, root / "tarballs" / source.name)
uid, gid = os.getuid(), os.getgid()
if uid == 0:
    account = pwd.getpwnam("nobody")
    uid, gid = account.pw_uid, account.pw_gid
    for directory, _dirs, files in os.walk(root):
        os.chown(directory, uid, gid)
        for name in files:
            os.chown(Path(directory) / name, uid, gid, follow_symlinks=False)


def identity():
    if os.getuid() == 0:
        os.setgroups([])
        os.setgid(gid)
        os.setuid(uid)


env = {
    key: value for key, value in os.environ.items() if key not in ["LD_LIBRARY_PATH", "NODE_PATH", "DYLD_LIBRARY_PATH"]
}
env.update(
    PATH=str(root / "bin"),
    npm_config_cache=str(root / "cache"),
    npm_config_userconfig="/dev/null",
    BRICK_HOME=str(root / "profiles"),
)
# A real npm installation with lifecycle scripts disabled must remain unusable;
# the CLI must report incomplete assets without downloading at first start.
subprocess.run(
    [
        str(root / "bin/npm"),
        "install",
        "--prefix",
        str(root / "installed"),
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        *map(str, sorted((root / "tarballs").glob("*.tgz"))),
    ],
    env=env,
    cwd=root,
    preexec_fn=identity,
    check=True,
)
package = root / "installed/node_modules/@regoloai/brick"
incomplete = subprocess.run(
    [str(root / "bin/node"), str(package / "bin/run.js"), "start", "incomplete"],
    env=env,
    cwd=root,
    preexec_fn=identity,
    capture_output=True,
    text=True,
)
assert incomplete.returncode != 0, "script-disabled installation started successfully"
assert "incomplete" in (incomplete.stdout + incomplete.stderr).lower(), incomplete.stderr
assert not (package / "assets/models").exists(), "first start downloaded assets"
shutil.rmtree(root / "installed/node_modules")
print("Script-disabled installation fails explicitly without downloading assets.", flush=True)
subprocess.run(
    [
        str(root / "bin/npm"),
        "install",
        "--prefix",
        str(root / "installed"),
        "--foreground-scripts",
        "--no-audit",
        "--no-fund",
        *map(str, sorted((root / "tarballs").glob("*.tgz"))),
    ],
    env=env,
    cwd=root,
    preexec_fn=identity,
    check=True,
)
# A root-run local check also verifies that another user can read an
# administrator-owned installation; profile data remains user-owned.
if os.getuid() == 0:
    for directory, _dirs, files in os.walk(root / "installed"):
        os.chown(directory, 0, 0)
        for name in files:
            os.chown(Path(directory) / name, 0, 0, follow_symlinks=False)
repo = Path(__file__).resolve().parents[1]
package = root / "installed/node_modules/@regoloai/brick"
for script in ["test_native_runtime.mjs", "test_native_unavailable.mjs"]:
    shutil.copy2(repo / "scripts" / script, root / script)
    target = package if script == "test_native_runtime.mjs" else package / "runtimes/linux-x64/bin/brick-runtime"
    subprocess.run(
        [str(root / "bin/node"), str(root / script), str(target)], env=env, cwd=root, preexec_fn=identity, check=True
    )
print(f"Installed and exercised Linux x64 package: {package}")
