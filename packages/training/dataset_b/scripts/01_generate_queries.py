"""Generate 50k queries for Dataset B via SGLang OpenAI-compat endpoint.

Reads configs/generation_specs.yaml, prompts/gen_*.txt; writes JSONL to data/raw/queries_generated.jsonl.

Idempotent: skips work if checkpoint file shows N records already done; appends.

Run on the GPU host where SGLang serves the generator (default localhost:30000).
"""

from __future__ import annotations

import argparse
import json
import os
import random
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import requests
import yaml

ROOT = Path(__file__).resolve().parent.parent
CONFIG = ROOT / "configs" / "generation_specs.yaml"
PROMPT_DIR = ROOT / "prompts"


def load_cfg() -> dict:
    return yaml.safe_load(CONFIG.read_text())


def weighted_choice(rng: random.Random, dist: dict[str, float]) -> str:
    keys = list(dist.keys())
    weights = [dist[k] for k in keys]
    return rng.choices(keys, weights=weights, k=1)[0]


def build_plan(cfg: dict, seed: int = 42) -> list[dict]:
    rng = random.Random(seed)
    plan: list[dict] = []
    dims = cfg["dimensions"]

    # single
    s = cfg["single_skill"]
    for dim in dims:
        for _ in range(s["count_per_dimension"]):
            plan.append(
                {
                    "split_type": "single_skill",
                    "target_dimensions": [dim],
                    "difficulty": weighted_choice(rng, s["difficulty_distribution"]),
                    "length": weighted_choice(rng, s["length_distribution"]),
                    "language": "English",
                }
            )

    # multi
    m = cfg["multi_skill"]
    n_pair = int(m["total_count"] * m["pair_share"])
    n_triple = m["total_count"] - n_pair
    for _ in range(n_pair):
        combo = rng.choice(m["pairs"])
        plan.append(
            {
                "split_type": "multi_skill",
                "target_dimensions": list(combo),
                "difficulty": weighted_choice(rng, m["difficulty_distribution"]),
                "length": "medium",
                "language": "English",
            }
        )
    for _ in range(n_triple):
        combo = rng.choice(m["triples"])
        plan.append(
            {
                "split_type": "multi_skill",
                "target_dimensions": list(combo),
                "difficulty": weighted_choice(rng, m["difficulty_distribution"]),
                "length": "medium",
                "language": "English",
            }
        )

    # edge
    e = cfg["edge_cases"]
    for etype, count in e["types"].items():
        for _ in range(count):
            plan.append(
                {
                    "split_type": "edge_case",
                    "target_dimensions": [],
                    "edge_type": etype,
                    "difficulty": "n/a",
                    "length": "n/a",
                    "language": "English",
                }
            )

    rng.shuffle(plan)
    pad = cfg["output"]["query_id_pad"]
    pre = cfg["output"]["query_id_prefix"]
    for i, item in enumerate(plan):
        item["query_id"] = f"{pre}{i:0{pad}d}"
    return plan


def render_prompt(spec: dict) -> str:
    if spec["split_type"] == "single_skill":
        tpl = (PROMPT_DIR / "gen_single.txt").read_text()
        return tpl.format(
            dimension=spec["target_dimensions"][0],
            difficulty=spec["difficulty"],
            length=spec["length"],
            language=spec["language"],
        )
    if spec["split_type"] == "multi_skill":
        tpl = (PROMPT_DIR / "gen_multi.txt").read_text()
        return tpl.format(
            dimensions=", ".join(spec["target_dimensions"]),
            difficulty=spec["difficulty"],
            language=spec["language"],
        )
    tpl = (PROMPT_DIR / "gen_edge.txt").read_text()
    return tpl.format(edge_type=spec["edge_type"])


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


def call_sglang(endpoint: str, prompt: str, gen_cfg: dict) -> str | None:
    payload = {
        "model": _resolve_model(endpoint),
        "messages": [{"role": "user", "content": prompt}],
        "temperature": gen_cfg["temperature"],
        "top_p": gen_cfg.get("top_p", 1.0),
        "max_tokens": gen_cfg["max_tokens"],
        "chat_template_kwargs": {"enable_thinking": False},
    }
    try:
        r = requests.post(endpoint, json=payload, timeout=120)
        r.raise_for_status()
        return r.json()["choices"][0]["message"]["content"].strip()
    except Exception as exc:
        print(f"[warn] sglang error: {exc}", file=sys.stderr)
        return None


def already_done_ids(out_path: Path) -> set[str]:
    if not out_path.exists():
        return set()
    done = set()
    with out_path.open() as f:
        for line in f:
            try:
                done.add(json.loads(line)["query_id"])
            except Exception:
                continue
    return done


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--endpoint", default="http://localhost:30000/v1/chat/completions")
    ap.add_argument("--max", type=int, default=0, help="limit (0=all)")
    ap.add_argument("--workers", type=int, default=32)
    ap.add_argument("--progress-every", type=int, default=200)
    ap.add_argument("--milestone-cb", default="", help="optional shell cmd run on 25/50/75% of total")
    args = ap.parse_args()

    cfg = load_cfg()
    out_path = ROOT / cfg["output"]["path"]
    out_path.parent.mkdir(parents=True, exist_ok=True)

    plan = build_plan(cfg)
    if args.max:
        plan = plan[: args.max]
    done = already_done_ids(out_path)
    todo = [p for p in plan if p["query_id"] not in done]
    total_target = len(plan)
    print(f"[info] plan={total_target} done={len(done)} todo={len(todo)}", file=sys.stderr)

    gen_cfg = cfg["generator"]
    milestones = {int(total_target * f): f for f in (0.25, 0.5, 0.75, 1.0)}
    seen_ms = set()

    def work(spec: dict) -> dict | None:
        prompt = render_prompt(spec)
        text = call_sglang(args.endpoint, prompt, gen_cfg)
        if text is None or len(text) < 3:
            return None
        spec["query"] = text
        spec["generator"] = gen_cfg["repo_id"]
        return spec

    written = len(done)
    t0 = time.time()
    with out_path.open("a") as fout, ThreadPoolExecutor(max_workers=args.workers) as pool:
        futures = [pool.submit(work, p) for p in todo]
        for fut in as_completed(futures):
            rec = fut.result()
            if rec is None:
                continue
            fout.write(json.dumps(rec, ensure_ascii=False) + "\n")
            fout.flush()
            written += 1
            if written % args.progress_every == 0:
                rate = (written - len(done)) / max(time.time() - t0, 1)
                eta = (total_target - written) / max(rate, 0.001)
                print(
                    f"[progress] {written}/{total_target} ({rate:.1f}/s, ETA {eta/60:.1f}m)",
                    file=sys.stderr,
                )
            for ms_count, frac in milestones.items():
                if frac in seen_ms:
                    continue
                if written >= ms_count:
                    seen_ms.add(frac)
                    if args.milestone_cb:
                        os.system(
                            f"{args.milestone_cb} 'gen_milestone_{int(frac*100)}' "
                            f"'Generation {int(frac*100)}%: {written}/{total_target}'"
                        )
    print(f"[done] wrote {written} records to {out_path}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
