"""Score Dataset B queries with one judge model via SGLang OpenAI-compat.

Reads data/raw/queries_generated.jsonl and writes data/labels/judge_<name>.jsonl.
Idempotent: skips query_ids already scored.

Run after launching SGLang serving the judge model on the cluster.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import requests
import yaml

ROOT = Path(__file__).resolve().parent.parent
JUDGES_CFG = ROOT / "configs" / "judges.yaml"
PROMPT_FILE = ROOT / "prompts" / "judge.txt"

DIMS = [
    "instruction_following",
    "coding",
    "math_reasoning",
    "world_knowledge",
    "planning_agentic",
    "creative_synthesis",
]

JSON_RE = re.compile(r"\{[^{}]*\}", re.DOTALL)


def parse_scores(text: str) -> dict[str, float] | None:
    if not text:
        return None
    candidates = JSON_RE.findall(text)
    for cand in candidates:
        try:
            obj = json.loads(cand)
        except json.JSONDecodeError:
            continue
        if not all(d in obj for d in DIMS):
            continue
        try:
            scores = {d: max(0.0, min(1.0, float(obj[d]))) for d in DIMS}
        except (TypeError, ValueError):
            continue
        return scores
    return None


_MODEL_NAME_CACHE: list[str] = []


def _resolve_model(endpoint: str) -> str:
    if _MODEL_NAME_CACHE:
        return _MODEL_NAME_CACHE[0]
    base = endpoint.rsplit("/v1/", 1)[0]
    try:
        r = requests.get(f"{base}/v1/models", timeout=15)
        r.raise_for_status()
        name = r.json()["data"][0]["id"]
    except Exception:
        name = "default"
    _MODEL_NAME_CACHE.append(name)
    return name


def call_judge(endpoint: str, query: str, infer_cfg: dict, *, retry_temp: float | None = None) -> dict | None:
    tpl = PROMPT_FILE.read_text()
    prompt = tpl.replace("{{", "\x00OB\x00").replace("}}", "\x00CB\x00")
    prompt = prompt.replace("{query_text}", query.replace('"""', "''"))
    prompt = prompt.replace("\x00OB\x00", "{").replace("\x00CB\x00", "}")
    payload = {
        "model": _resolve_model(endpoint),
        "messages": [{"role": "user", "content": prompt}],
        "temperature": retry_temp if retry_temp is not None else infer_cfg["temperature"],
        "max_tokens": infer_cfg["max_tokens"],
    }
    try:
        r = requests.post(endpoint, json=payload, timeout=infer_cfg["request_timeout_sec"])
        r.raise_for_status()
        msg = r.json()["choices"][0]["message"]
        text = msg.get("content") or ""
        if not text:
            text = msg.get("reasoning") or msg.get("reasoning_content") or ""
    except Exception as exc:
        return {"error": f"http: {exc}"}
    if not text:
        return {"error": "empty_response"}
    scores = parse_scores(text)
    if scores is None:
        return {"error": "parse_fail", "raw": text[:500]}
    return {"scores": scores}


def already_scored(out_path: Path) -> set[str]:
    if not out_path.exists():
        return set()
    done = set()
    with out_path.open() as f:
        for line in f:
            try:
                rec = json.loads(line)
                if "scores" in rec and rec.get("query_id"):
                    done.add(rec["query_id"])
            except Exception:
                continue
    return done


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--name", required=True, help="judge name (mistral|gptoss|gemma|nemotron)")
    ap.add_argument("--input", default=str(ROOT / "data" / "raw" / "queries_generated.jsonl"))
    ap.add_argument("--output", default="")
    ap.add_argument("--endpoint", default="http://localhost:30000/v1/chat/completions")
    ap.add_argument("--workers", type=int, default=48)
    ap.add_argument("--max", type=int, default=0)
    ap.add_argument("--milestone-cb", default="")
    args = ap.parse_args()

    cfg = yaml.safe_load(JUDGES_CFG.read_text())
    infer_cfg = cfg["inference"]
    judges = {j["name"]: j for j in cfg["judges"]}
    if args.name not in judges:
        print(f"[err] unknown judge: {args.name}", file=sys.stderr)
        return 2

    out_path = Path(args.output) if args.output else ROOT / "data" / "labels" / f"judge_{args.name}.jsonl"
    out_path.parent.mkdir(parents=True, exist_ok=True)

    inp = Path(args.input)
    queries: list[dict] = []
    with inp.open() as f:
        for line in f:
            try:
                queries.append(json.loads(line))
            except Exception:
                continue
    if args.max:
        queries = queries[: args.max]
    done = already_scored(out_path)
    todo = [q for q in queries if q["query_id"] not in done]
    total = len(queries)
    print(f"[info] judge={args.name} total={total} done={len(done)} todo={len(todo)}", file=sys.stderr)

    milestones = {int(total * f): f for f in (0.25, 0.5, 0.75, 1.0)}
    seen_ms = set()
    parse_fails = 0
    written = len(done)
    t0 = time.time()

    def work(rec: dict) -> dict:
        out = call_judge(args.endpoint, rec["query"], infer_cfg)
        if out is None or "error" in out:
            # one retry at temperature=0
            out2 = call_judge(args.endpoint, rec["query"], infer_cfg, retry_temp=0.0)
            if out2 and "scores" in out2:
                out = out2
        return {
            "query_id": rec["query_id"],
            "judge": args.name,
            **out,
        }

    with out_path.open("a") as fout, ThreadPoolExecutor(max_workers=args.workers) as pool:
        futs = [pool.submit(work, q) for q in todo]
        for fut in as_completed(futs):
            rec = fut.result()
            fout.write(json.dumps(rec, ensure_ascii=False) + "\n")
            fout.flush()
            written += 1
            if "error" in rec:
                parse_fails += 1
            if written % 500 == 0:
                rate = (written - len(done)) / max(time.time() - t0, 1)
                eta = (total - written) / max(rate, 0.001)
                print(
                    f"[progress] {args.name} {written}/{total} parse_fail={parse_fails} "
                    f"({rate:.1f}/s, ETA {eta/60:.1f}m)",
                    file=sys.stderr,
                )
            for ms_count, frac in milestones.items():
                if frac in seen_ms:
                    continue
                if written >= ms_count:
                    seen_ms.add(frac)
                    if args.milestone_cb:
                        os.system(
                            f"{args.milestone_cb} 'judge_{args.name}_{int(frac*100)}' "
                            f"'Judge {args.name} {int(frac*100)}%: {written}/{total} parse_fail={parse_fails}'"
                        )

    print(
        f"[done] judge={args.name} written={written} parse_fail={parse_fails} "
        f"rate={parse_fails/max(written,1):.3%}",
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
