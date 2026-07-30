#!/usr/bin/env python3
"""Suite A/B: misura il risparmio reale di Brick sul consumo del piano Claude.

Esegue la stessa task suite headless (claude -p) in due rami:
  brick_on  : --model brick-claude       (skill router attivo)
  brick_off : --model <modello nativo>   (passthrough puro verso Anthropic)

Entrambi i rami passano dal proxy Brick, che dopo le modifiche al router logga
per OGNI risposta Anthropic (routed e native) token reali, header
anthropic-ratelimit-* e il tag di attribuzione x-brick-ab-tag in
routing_events.jsonl. Il report (report.py) fa il join per tag.

Uso:
  python3 run_suite.py --smoke          # 1 task, entrambi i rami, auto-verifica
  python3 run_suite.py                  # suite completa (default 2 rep, ordine abba)
  python3 run_suite.py --reps 1 --tasks 'qa_*'
"""

import argparse
import datetime as dt
import fnmatch
import json
import os
import shutil
import signal
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

import yaml

SUITE_DIR = Path(__file__).resolve().parent
FIXTURE_SRC = SUITE_DIR / "fixture_src"
TASKS_DIR = SUITE_DIR / "tasks"
WORK_FIXTURE = SUITE_DIR / ".work" / "fixture"
OUT_DIR = SUITE_DIR / "out" / "runs"

EVENTS_PATH_IN_CONTAINER = "/app/config/routing_events.jsonl"


def utcnow() -> str:
    return dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")


def log(msg: str) -> None:
    print(f"[{dt.datetime.now().strftime('%H:%M:%S')}] {msg}", flush=True)


# ---------------------------------------------------------------- profile


def load_profile(args):
    """Risolve profilo brick attivo, porta del proxy e nome container."""
    profile = args.profile
    if not profile:
        state = Path.home() / ".brick" / "state.json"
        if state.exists():
            profile = json.loads(state.read_text()).get("activeProfile")
    if not profile:
        sys.exit("profilo brick non trovato: passa --profile")

    cfg_path = Path.home() / ".brick" / "profiles" / profile / "config.yaml"
    if not cfg_path.exists():
        sys.exit(f"config profilo assente: {cfg_path}")
    cfg = yaml.safe_load(cfg_path.read_text())

    port = args.port or cfg.get("server_port", 8000)
    url = args.url or f"http://localhost:{port}"
    container = args.container or f"brick-{profile}-router"

    ap = cfg.get("anthropic_passthrough") or {}
    if not ap.get("enabled", False):
        sys.exit("anthropic_passthrough.enabled deve essere true nel profilo")
    if ap.get("route_subagents", False):
        sys.exit(
            "route_subagents: true nel profilo: il ramo OFF verrebbe routato. "
            "Disattivalo (o adatta la suite) prima di misurare."
        )
    return profile, url, container


def health_check(url: str) -> None:
    try:
        with urllib.request.urlopen(f"{url}/health", timeout=5) as r:
            if r.status != 200:
                sys.exit(f"/health ha risposto {r.status}")
    except Exception as e:  # noqa: BLE001
        sys.exit(f"proxy Brick non raggiungibile su {url}: {e}")


def snapshot(container: str, run_dir: Path, label: str, url: str) -> Path:
    """Estrae routing_events.jsonl dal container + stats/economics API."""
    dest = run_dir / f"events_snapshot_{label}.jsonl"
    try:
        subprocess.run(
            ["docker", "cp", f"{container}:{EVENTS_PATH_IN_CONTAINER}", str(dest)],
            check=True, capture_output=True, timeout=30,
        )
    except subprocess.CalledProcessError as e:
        log(f"WARN docker cp fallito ({label}): {e.stderr.decode(errors='replace').strip()}")
    for api in ("routing/stats", "economics"):
        try:
            with urllib.request.urlopen(f"{url}/api/v1/{api}", timeout=10) as r:
                (run_dir / f"{api.replace('/', '_')}_{label}.json").write_bytes(r.read())
        except Exception as e:  # noqa: BLE001
            log(f"WARN snapshot {api} ({label}): {e}")
    return dest


# ---------------------------------------------------------------- tasks


def load_tasks(pattern: str):
    """pattern: uno o piu glob separati da virgola (es. 'qa_0[13]*,bugfix_*')."""
    globs = [g.strip() for g in pattern.split(",") if g.strip()]
    tasks = []
    for path in sorted(TASKS_DIR.glob("*.yaml")):
        t = yaml.safe_load(path.read_text())
        if any(fnmatch.fnmatch(t["id"], g) for g in globs):
            tasks.append(t)
    if not tasks:
        sys.exit(f"nessun task corrisponde a --tasks '{pattern}'")
    return tasks


def reset_fixture(task) -> None:
    """Copia pulita della fixture + repo git usa e getta + setup del task."""
    if WORK_FIXTURE.exists():
        shutil.rmtree(WORK_FIXTURE)
    WORK_FIXTURE.parent.mkdir(parents=True, exist_ok=True)
    shutil.copytree(FIXTURE_SRC, WORK_FIXTURE)
    run = lambda *cmd: subprocess.run(  # noqa: E731
        cmd, cwd=WORK_FIXTURE, check=True, capture_output=True
    )
    run("git", "init", "-q")
    run("git", "add", "-A")
    run("git", "-c", "user.email=suite@brick", "-c", "user.name=ab-suite",
        "commit", "-qm", "seed fixture")
    if task.get("setup"):
        setup = TASKS_DIR / task["setup"]
        r = subprocess.run(
            ["bash", str(setup)], cwd=WORK_FIXTURE, capture_output=True, text=True
        )
        if r.returncode != 0:
            sys.exit(f"setup {setup.name} fallito: {r.stdout}\n{r.stderr}")


def run_claude(task, model: str, tag: str, url: str, out_file: Path, timeout: int):
    # Env pulito: rimuove le variabili di una eventuale sessione Claude Code
    # ospite (nested run) e qualsiasi ANTHROPIC_* ereditata, poi imposta solo
    # cio che serve alla suite. HOME resta invariata (OAuth in ~/.claude).
    env = {
        k: v for k, v in os.environ.items()
        if not k.startswith(("CLAUDE", "ANTHROPIC"))
    }
    env["ANTHROPIC_BASE_URL"] = url
    env["ANTHROPIC_CUSTOM_HEADERS"] = f"x-brick-ab-tag: {tag}"
    # Consente --dangerously-skip-permissions anche come root (ambiente
    # containerizzato/dedicato: e il caso d'uso di questa suite headless).
    env["IS_SANDBOX"] = "1"
    cmd = [
        "claude", "-p", task["prompt"],
        "--model", model,
        "--dangerously-skip-permissions",
        "--max-turns", str(task.get("max_turns", 30)),
    ]
    with out_file.open("w") as fh:
        proc = subprocess.Popen(
            cmd, cwd=WORK_FIXTURE, env=env,
            stdout=fh, stderr=subprocess.STDOUT,
            start_new_session=True,
        )
        try:
            proc.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
            proc.wait()
            return proc.returncode if proc.returncode is not None else -9, True
    return proc.returncode, False


def run_check(task, out_file: Path) -> bool:
    check = TASKS_DIR / task["check"]
    env = os.environ.copy()
    env["OUT_FILE"] = str(out_file)
    r = subprocess.run(
        ["bash", str(check)], cwd=WORK_FIXTURE, env=env,
        capture_output=True, text=True, timeout=300,
    )
    return r.returncode == 0


# ---------------------------------------------------------------- abort guard


def read_events(path: Path):
    events = []
    if not path.exists():
        return events
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            events.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return events


def assert_not_rate_limited(events, run_tags) -> None:
    for ev in events:
        if ev.get("request_tag") not in run_tags:
            continue
        rl = ev.get("ratelimit_headers") or {}
        if ev.get("upstream_status") == 429 or rl.get("unified-status") == "rejected":
            reset = rl.get("unified-reset", "?")
            sys.exit(
                f"ABORT: piano Claude rate-limited (reset {reset}). "
                "Il confronto sarebbe sporco: rilancia dopo il reset."
            )


# ---------------------------------------------------------------- main flow


def build_schedule(tasks, branches, reps, order):
    """Lista di (task, branch, rep). abba alterna il ramo che parte per primo
    a ogni task, cosi cache Anthropic e deriva della finestra 5h colpiscono i
    rami simmetricamente. block esegue prima tutto un ramo, poi l'altro."""
    sched = []
    if order == "block":
        for branch in branches:
            for rep in range(1, reps + 1):
                for t in tasks:
                    sched.append((t, branch, rep))
        return sched
    for rep in range(1, reps + 1):
        for i, t in enumerate(tasks):
            pair = branches if (i + rep) % 2 == 0 else list(reversed(branches))
            for branch in pair:
                sched.append((t, branch, rep))
    return sched


def smoke_verify(events, tags_by_branch, off_model) -> bool:
    ok = True

    def fail(msg):
        nonlocal ok
        ok = False
        print(f"  FAIL {msg}")

    by_tag = {}
    for ev in events:
        tag = ev.get("request_tag")
        if tag:
            by_tag.setdefault(tag, []).append(ev)

    on_evs = [e for t in tags_by_branch["brick_on"] for e in by_tag.get(t, [])]
    off_evs = [e for t in tags_by_branch["brick_off"] for e in by_tag.get(t, [])]

    if not on_evs:
        fail("nessun evento col tag del ramo ON: tag join non funziona")
    elif not all(e.get("mode") and e.get("served_model") for e in on_evs):
        fail(f"evento ON incompleto: {on_evs[0]}")
    else:
        print(f"  PASS ramo ON: {len(on_evs)} eventi, served={on_evs[0].get('served_model')}")

    if not off_evs:
        fail("nessun evento col tag del ramo OFF")
    else:
        bad = [e for e in off_evs if e.get("mode") != "passthrough_native"]
        native_ok = [e for e in off_evs if e.get("served_model") == off_model]
        if bad:
            fail(f"evento OFF con mode {bad[0].get('mode')}, atteso passthrough_native")
        elif not native_ok:
            fail(f"nessun evento OFF servito da {off_model}")
        else:
            print(f"  PASS ramo OFF: {len(off_evs)} eventi passthrough_native")

    all_evs = on_evs + off_evs
    with_rl = [e for e in all_evs if e.get("ratelimit_headers")]
    unified = [
        e for e in with_rl
        if any(k.startswith("unified-") for k in e["ratelimit_headers"])
    ]
    if unified:
        sample = {k: v for k, v in unified[-1]["ratelimit_headers"].items()
                  if k.startswith("unified-")}
        print(f"  PASS header unified presenti: {sample}")
    else:
        print("  WARN nessun header unified-*: il report usera solo token/plan_units")

    with_tokens = [
        e for e in all_evs
        if (e.get("fresh_input_tokens", 0) + e.get("cache_read_tokens", 0)
            + e.get("output_tokens", 0)) > 0
    ]
    if with_tokens:
        print(f"  PASS token catturati su {len(with_tokens)}/{len(all_evs)} eventi")
    else:
        fail("nessun evento con token > 0")
    return ok


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--smoke", action="store_true", help="solo qa_01, 1 rep, auto-verifica")
    ap.add_argument("--reps", type=int, default=2)
    ap.add_argument("--order", choices=["abba", "block"], default="abba")
    ap.add_argument("--tasks", default="*", help="glob sugli id dei task")
    ap.add_argument("--on-model", default="brick-claude")
    ap.add_argument("--off-model", default="claude-sonnet-4-6")
    ap.add_argument("--profile", default=None)
    ap.add_argument("--port", type=int, default=None)
    ap.add_argument("--url", default=None)
    ap.add_argument("--container", default=None)
    ap.add_argument("--sleep", type=float, default=2.0, help="pausa tra run")
    args = ap.parse_args()

    profile, url, container = load_profile(args)
    health_check(url)
    if shutil.which("claude") is None:
        sys.exit("claude CLI non trovata nel PATH")

    if args.smoke:
        args.tasks, args.reps = "qa_01*", 1
    tasks = load_tasks(args.tasks)

    run_id = dt.datetime.now().strftime("%Y%m%d_%H%M%S")
    run_dir = OUT_DIR / run_id
    run_dir.mkdir(parents=True, exist_ok=True)
    branches = {"brick_on": args.on_model, "brick_off": args.off_model}
    (run_dir / "meta.json").write_text(json.dumps({
        "run_id": run_id, "profile": profile, "url": url, "container": container,
        "branches": branches, "reps": args.reps, "order": args.order,
        "tasks": [t["id"] for t in tasks], "smoke": args.smoke,
        "started_at": utcnow(),
    }, indent=2))

    log(f"run {run_id}: {len(tasks)} task x {args.reps} rep x 2 rami "
        f"(profilo {profile}, proxy {url})")
    snapshot(container, run_dir, "start", url)

    schedule = build_schedule(tasks, list(branches), args.reps, args.order)
    runs_path = run_dir / "task_runs.jsonl"
    all_tags = set()
    tags_by_branch = {b: [] for b in branches}

    for i, (task, branch, rep) in enumerate(schedule, 1):
        model = branches[branch]
        tag = f"{run_id}|{branch}|{task['id']}|rep{rep}"
        all_tags.add(tag)
        tags_by_branch[branch].append(tag)
        out_sub = run_dir / branch / f"{task['id']}_rep{rep}"
        out_sub.mkdir(parents=True, exist_ok=True)
        out_file = out_sub / "out.txt"

        log(f"[{i}/{len(schedule)}] {branch} {task['id']} rep{rep} (model {model})")
        reset_fixture(task)
        t_start = utcnow()
        rc, timed_out = run_claude(
            task, model, tag, url, out_file, task.get("timeout_seconds", 600))
        t_end = utcnow()
        passed = run_check(task, out_file)

        record = {
            "run_id": run_id, "branch": branch, "task_id": task["id"],
            "category": task["category"], "rep": rep, "tag": tag, "model": model,
            "t_start": t_start, "t_end": t_end, "exit_code": rc,
            "timed_out": timed_out, "check_passed": passed,
        }
        with runs_path.open("a") as fh:
            fh.write(json.dumps(record) + "\n")
        log(f"    exit={rc} timeout={timed_out} check={'PASS' if passed else 'FAIL'}")

        snap = snapshot(container, run_dir, "latest", url)
        assert_not_rate_limited(read_events(snap), all_tags)
        time.sleep(args.sleep)

    final = snapshot(container, run_dir, "final", url)
    (run_dir / "meta.json").write_text(json.dumps({
        **json.loads((run_dir / "meta.json").read_text()),
        "finished_at": utcnow(),
    }, indent=2))
    log(f"run completata: {run_dir}")

    if args.smoke:
        print("\n=== SMOKE VERIFY ===")
        ok = smoke_verify(read_events(final), tags_by_branch, args.off_model)
        print("=== SMOKE", "PASS" if ok else "FAIL", "===")
        sys.exit(0 if ok else 1)
    print(f"\nReport: python3 {SUITE_DIR / 'report.py'} {run_dir}")


if __name__ == "__main__":
    main()
