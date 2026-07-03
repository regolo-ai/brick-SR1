"""Run inference Dataset A su un modello OpenRouter (deepseek-v4-flash | kimi2.6).

Pipeline:
  1. Carica `data/final/evaluation_parameters_full.jsonl`
  2. Filtra dimension (default: tutte tranne planning_agentic)
  3. Resume: skip query_id già presenti in --output
  4. Async pool 8 worker → OpenRouterClient.chat()
  5. Append JSONL atomico (una riga per call)
  6. Report finale: count, errors, cost, latency p50/p95, thinking-capture-rate

Usage:
  python scripts/100_run_inference.py --model deepseek-v4-flash --limit-per-dim 20 \\
      --output data/inference/deepseek-v4-flash/dataset_a_smoke.jsonl
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
import time
from collections import Counter, defaultdict
from pathlib import Path

import httpx

# Permette esecuzione diretta senza pip install -e .
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from brick_evals.io_utils import (  # noqa: E402
    configs_dir,
    load_jsonl,
    load_yaml,
    repo_root,
    utc_now_iso,
)
from brick_evals.openrouter_client import OpenRouterClient  # noqa: E402

DEFAULT_DIMENSIONS = [
    "coding",
    "math_reasoning",
    "creative_synthesis",
    "instruction_following",
    "world_knowledge",
    "planning_agentic",
]
EXCLUDED_DIMENSIONS: set[str] = set()
DEFAULT_CONCURRENCY = 8

# max_tokens per (dimension, evaluation_protocol_id). `max_tokens` include reasoning.
# Tarati per modelli con thinking ON (DeepSeek V4, Kimi K2.5) seguendo SOTA 2025:
# 32K math/code (DeepSeek-R1, Kimi K2.5 standard), 8K IF/MCQ, 2K SimpleQA.
# Note: max_tokens è CAP, non target; il costo cresce solo quando il modello satura.
MAX_TOKENS_RULES: dict[tuple[str, str | None], int] = {
    # Cap tarati per Qwen3.5-9B (vLLM reasoning-parser conta il thinking nel cap):
    # re-run 2026-05-14 sui 4 protocolli troncati. coding 65536→49152 per stare
    # sotto max-model-len 65536 con l'input; creative 24576→40960 (16K thinking +
    # ~24K storia, 24576 dava solo ~8K → 20% finish=length).
    # NB: TEMP BUMP precedente (Kimi skip-retry): da rivedere quando si riprende Kimi.
    ("coding", None): 49152,  # 16K thinking + ~32K code, sotto max-model-len
    ("math_reasoning", None): 49152,  # bump 32K→48K (math hard ~26K reasoning)
    ("creative_synthesis", None): 40960,  # 16K thinking + ~24K storia (era 24576 → 20% trunc)
    ("instruction_following", None): 32768,  # confermato pilota: 4/4 stop
    ("world_knowledge", "mcq_letter"): 24576,  # confermato pilota: 2/2 stop
    ("world_knowledge", "llm_judge_factual"): 24576,
    ("world_knowledge", None): 8192,
    # planning_agentic: BFCL response = tool_call breve; rubric_judge = piano multi-step
    # 2026-05-15 Kimi K2.6 retry-18: cap precedenti (4096 ST + 20480 PC) saturati nel
    # thinking → response vuote. K2.6 conta il thinking nel cap (al contrario di K2.5).
    ("planning_agentic", "tool_call_match"): 8192,  # was 4096; Kimi K2.6 thinking-heavy anche su BFCL
    ("planning_agentic", "rubric_judge"): 40960,  # was 20480; bump Kimi K2.6 (q_04213 saturava 28672 nel thinking)
    ("planning_agentic", None): 8192,
}


def resolve_max_tokens(dimension: str, protocol: str | None) -> int:
    if (dimension, protocol) in MAX_TOKENS_RULES:
        return MAX_TOKENS_RULES[(dimension, protocol)]
    return MAX_TOKENS_RULES.get((dimension, None), 2048)


# System prompt usato per le query BFCL (tool_call_match): presenta le funzioni
# disponibili e impone il formato di output Python-style atteso dall'AST checker.
_BFCL_SYSTEM_TEMPLATE = """You are a function-calling assistant. You have access to the following functions:

```json
{functions_json}
```

Read the user's request carefully. Determine which function(s) to call and with what arguments.

Output ONLY a Python expression with the call(s), no prose, no markdown fences:
  - single call:   function_name(arg1=value1, arg2=value2)
  - parallel calls: [function_name1(...), function_name2(...)]
  - irrelevant request (none of the functions apply): output exactly: []

Do not invent functions that aren't listed."""


def build_messages_for_row(row: dict) -> list[dict]:
    """Costruisce `messages` per `OpenRouterClient.chat`.

    Default: messaggio utente unico = `row["query"]`.
    Caso speciale `evaluation_protocol_id == "tool_call_match"` (BFCL single-turn):
    aggiunge un system prompt che presenta le `function_specs` dal payload e
    impone il formato Python-style atteso da `bfcl_grader.extract_calls`.
    """
    query = row.get("query") or ""
    proto = row.get("evaluation_protocol_id")
    if proto == "tool_call_match":
        payload = (row.get("expected_answer") or {}).get("payload") or {}
        specs = payload.get("function_specs") or []
        system = _BFCL_SYSTEM_TEMPLATE.format(functions_json=json.dumps(specs, ensure_ascii=False, indent=2))
        return [
            {"role": "system", "content": system},
            {"role": "user", "content": query},
        ]
    return [{"role": "user", "content": query}]


def load_model_config(alias: str) -> dict:
    cfg = load_yaml(configs_dir() / "models.yaml")
    for key, m in cfg.items():
        if not isinstance(m, dict):
            continue
        if m.get("alias") == alias or key == alias:
            if "openrouter_id" not in m:
                raise ValueError(f"models.yaml: {key} missing openrouter_id")
            return m
    raise ValueError(f"alias '{alias}' not found in configs/models.yaml")


def load_done_ids(path: Path) -> set[str]:
    if not path.exists():
        return set()
    done = set()
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                row = json.loads(line)
                if qid := row.get("query_id"):
                    done.add(qid)
            except json.JSONDecodeError:
                continue
    return done


def filter_rows(
    *,
    rows: list[dict],
    dimensions: list[str],
    limit_per_dim: int | None,
    done_ids: set[str],
    exclude_protocols: set[str] | None = None,
) -> list[dict]:
    exclude_protocols = exclude_protocols or set()
    by_dim: dict[str, list[dict]] = defaultdict(list)
    for r in rows:
        d = r.get("dimension")
        if d in EXCLUDED_DIMENSIONS or d not in dimensions:
            continue
        if r.get("evaluation_protocol_id") in exclude_protocols:
            continue
        if r.get("query_id") in done_ids:
            continue
        by_dim[d].append(r)
    out: list[dict] = []
    for d in dimensions:
        bucket = by_dim.get(d, [])
        if limit_per_dim is not None:
            bucket = bucket[:limit_per_dim]
        out.extend(bucket)
    return out


async def process_row(
    *,
    client: OpenRouterClient,
    row: dict,
    model_alias: str,
    model_id: str,
    sem: asyncio.Semaphore,
    out_path: Path,
    write_lock: asyncio.Lock,
    reasoning: bool,
    pbar: dict,
    extra_body: dict | None = None,
) -> dict:
    dim = row["dimension"]
    proto = row.get("evaluation_protocol_id")
    max_tokens = resolve_max_tokens(dim, proto)

    async with sem:
        result = await client.chat(
            model=model_id,
            messages=build_messages_for_row(row),
            temperature=0.0,
            max_tokens=max_tokens,
            top_p=1.0,
            reasoning=reasoning,
            extra_body=extra_body,
        )

    record = {
        "query_id": row["query_id"],
        "model_name": model_alias,
        "model_id_real": model_id,
        "dimension": dim,
        "evaluation_protocol_id": proto,
        "model_raw_thinking_output": result.reasoning,
        "model_raw_response": result.content,
        "correct": None,
        "reasoning_tokens": result.reasoning_tokens,
        "completion_tokens": result.completion_tokens,
        "input_tokens": result.prompt_tokens,
        "cost": result.cost,
        "latency_ms": result.latency_ms,
        "finish_reason": result.finish_reason,
        "timestamp": utc_now_iso(),
        "params": {
            "temperature": 0.0,
            "max_tokens": max_tokens,
            "top_p": 1.0,
            "reasoning": reasoning,
        },
        "error": result.error,
        "attempt": result.attempt,
    }

    line = json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n"
    async with write_lock:
        with open(out_path, "a", encoding="utf-8") as f:
            f.write(line)
            f.flush()

    pbar["done"] += 1
    if result.error:
        pbar["errors"] += 1
    if result.reasoning:
        pbar["thinking"] += 1
    if result.cost:
        pbar["cost_total"] += result.cost
    pbar["latencies"].append(result.latency_ms)
    pbar["per_dim"][dim] += 1

    if pbar["done"] % max(1, pbar["report_every"]) == 0:
        elapsed = time.perf_counter() - pbar["t0"]
        rate = pbar["done"] / elapsed if elapsed > 0 else 0
        print(
            f"  [{pbar['done']}/{pbar['total']}] errors={pbar['errors']} "
            f"thinking={pbar['thinking']} cost=${pbar['cost_total']:.4f} "
            f"rate={rate:.2f}/s",
            flush=True,
        )

    # Circuit breaker: il watchdog (task asincrono) setta pbar["aborted"]=True
    # quando OpenRouter total_usage - baseline supera il cap. Qui propaghiamo cancel.
    if pbar.get("aborted"):
        raise asyncio.CancelledError(f"budget cap exceeded (API usage delta ${pbar.get('api_usage_delta',0):.4f})")

    return record


async def fetch_openrouter_usage(api_key: str) -> float | None:
    """GET /v1/credits → ritorna total_usage corrente (USD). None su fail."""
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            r = await client.get(
                "https://openrouter.ai/api/v1/credits",
                headers={"Authorization": f"Bearer {api_key}"},
            )
            if r.status_code == 200:
                return float(r.json().get("data", {}).get("total_usage", 0))
    except Exception:
        pass
    return None


async def budget_watchdog(
    *, api_key: str, baseline: float, cap: float, pbar: dict, poll_interval: float = 30.0
) -> None:
    """Polla OpenRouter usage ogni `poll_interval` secondi.
    Se (current_usage - baseline) > cap → segnala abort via pbar["aborted"]."""
    while not pbar.get("aborted") and not pbar.get("finished"):
        await asyncio.sleep(poll_interval)
        usage = await fetch_openrouter_usage(api_key)
        if usage is None:
            continue
        delta = usage - baseline
        pbar["api_usage_delta"] = delta
        pbar["api_usage_absolute"] = usage
        if delta > cap:
            pbar["aborted"] = True
            print(
                f"\n[WATCHDOG ABORT] OpenRouter total_usage ${usage:.4f} "
                f"(delta ${delta:.4f} > cap ${cap:.2f}). Triggering global abort.",
                flush=True,
            )
            return


def percentile(values: list[int], p: float) -> int:
    if not values:
        return 0
    s = sorted(values)
    k = max(0, min(len(s) - 1, int(round((p / 100) * (len(s) - 1)))))
    return s[k]


async def run(
    *,
    model_alias: str,
    dimensions: list[str],
    limit_per_dim: int | None,
    output: Path,
    concurrency: int,
    reasoning: bool,
    dataset_path: Path,
    endpoint_url: str | None = None,
    endpoint_key: str | None = None,
    model_id_override: str | None = None,
    extra_body: dict | None = None,
    model_name_override: str | None = None,
    exclude_protocols: set[str] | None = None,
    max_budget: float | None = None,
) -> None:
    cfg = load_model_config(model_alias)
    model_id = model_id_override or cfg["openrouter_id"]
    model_name = model_name_override or model_alias
    print(f"[runner] alias={model_alias} model_name={model_name} model_id={model_id}")
    if endpoint_url:
        print(f"[runner] endpoint_url={endpoint_url} (custom)")
    if extra_body:
        print(f"[runner] extra_body={extra_body}")
    if exclude_protocols:
        print(f"[runner] exclude_protocols={sorted(exclude_protocols)}")
    print(f"[runner] dataset={dataset_path}")
    print(f"[runner] output={output}")

    output.parent.mkdir(parents=True, exist_ok=True)
    done_ids = load_done_ids(output)
    if done_ids:
        print(f"[runner] resume: {len(done_ids)} query_id già processati, skip")

    rows_all = list(load_jsonl(dataset_path))
    rows = filter_rows(
        rows=rows_all,
        dimensions=dimensions,
        limit_per_dim=limit_per_dim,
        done_ids=done_ids,
        exclude_protocols=exclude_protocols,
    )
    if not rows:
        print("[runner] nessuna riga da processare. Esco.")
        return

    by_dim = Counter(r["dimension"] for r in rows)
    print(f"[runner] da processare: {len(rows)} righe, by_dim={dict(by_dim)}")
    print(f"[runner] concurrency={concurrency} reasoning={reasoning}")

    pbar = {
        "t0": time.perf_counter(),
        "done": 0,
        "errors": 0,
        "thinking": 0,
        "cost_total": 0.0,
        "latencies": [],
        "per_dim": Counter(),
        "total": len(rows),
        "report_every": max(1, len(rows) // 20),
        "budget_cap": max_budget,
        "aborted": False,
        "finished": False,
        "api_usage_delta": 0.0,
        "api_usage_absolute": 0.0,
    }

    sem = asyncio.Semaphore(concurrency)
    write_lock = asyncio.Lock()

    client_kwargs: dict = {}
    if endpoint_url:
        client_kwargs["base_url"] = endpoint_url
    if endpoint_key:
        client_kwargs["api_key"] = endpoint_key

    # Setup watchdog se max_budget specificato: usa OpenRouter /credits API come ground truth
    watchdog_task: asyncio.Task | None = None
    baseline_usage: float | None = None
    if max_budget and endpoint_url is None:
        # Solo per OpenRouter (no custom endpoint). Carica chiave + baseline.
        from brick_evals.io_utils import openrouter_key

        api_key = endpoint_key or openrouter_key()
        baseline_usage = await fetch_openrouter_usage(api_key)
        if baseline_usage is None:
            print("[runner] WARNING: impossibile leggere baseline usage OpenRouter. Watchdog disabilitato.")
        else:
            print(
                f"[runner] budget cap=${max_budget:.2f} | baseline usage=${baseline_usage:.4f} | "
                f"abort threshold=${baseline_usage + max_budget:.4f} (poll 30s)"
            )
            watchdog_task = asyncio.create_task(
                budget_watchdog(
                    api_key=api_key,
                    baseline=baseline_usage,
                    cap=max_budget,
                    pbar=pbar,
                    poll_interval=30.0,
                )
            )

    async with OpenRouterClient(**client_kwargs) as client:
        tasks = [
            process_row(
                client=client,
                row=r,
                model_alias=model_name,
                model_id=model_id,
                sem=sem,
                out_path=output,
                write_lock=write_lock,
                reasoning=reasoning,
                pbar=pbar,
                extra_body=extra_body,
            )
            for r in rows
        ]
        try:
            await asyncio.gather(*tasks, return_exceptions=False)
        except asyncio.CancelledError as e:
            print(f"[runner] ABORTED: {e}", flush=True)
        finally:
            pbar["finished"] = True
            if watchdog_task and not watchdog_task.done():
                watchdog_task.cancel()
                try:
                    await watchdog_task
                except asyncio.CancelledError:
                    pass

    elapsed = time.perf_counter() - pbar["t0"]
    p50 = percentile(pbar["latencies"], 50)
    p95 = percentile(pbar["latencies"], 95)
    print()
    print(f"[runner] DONE in {elapsed:.1f}s")
    print(f"  total_calls={pbar['done']}  errors={pbar['errors']} ({pbar['errors']/max(pbar['done'],1)*100:.1f}%)")
    print(f"  thinking_captured={pbar['thinking']}/{pbar['done']} ({pbar['thinking']/max(pbar['done'],1)*100:.1f}%)")
    print(f"  cost_total=${pbar['cost_total']:.4f}  avg=${pbar['cost_total']/max(pbar['done'],1):.5f}")
    print(f"  latency_ms p50={p50}  p95={p95}")
    print(f"  by_dim={dict(pbar['per_dim'])}")


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Run inference Dataset A su modello OpenRouter")
    p.add_argument("--model", required=True, help="alias modello (es. deepseek-v4-flash, kimi2.6)")
    p.add_argument(
        "--dimensions",
        default=",".join(DEFAULT_DIMENSIONS),
        help="comma-separated, default tutte le 5 (no planning_agentic)",
    )
    p.add_argument(
        "--limit-per-dim",
        type=int,
        default=None,
        help="N righe per dimension (smoke-test). Default: nessun limite (full).",
    )
    p.add_argument(
        "--output",
        type=Path,
        required=True,
        help="path JSONL output (append-resume)",
    )
    p.add_argument("--concurrency", type=int, default=DEFAULT_CONCURRENCY)
    p.add_argument(
        "--no-reasoning",
        action="store_true",
        help="disabilita reasoning.enabled=true (default: abilitato)",
    )
    p.add_argument(
        "--dataset",
        type=Path,
        default=repo_root() / "data" / "final" / "evaluation_parameters_full.jsonl",
    )
    # Custom endpoint (es. SGLang locale): override OpenRouter default
    p.add_argument(
        "--endpoint-url",
        default=None,
        help="custom OpenAI-compatible base_url (es. http://localhost:30000/v1)",
    )
    p.add_argument(
        "--endpoint-key",
        default=None,
        help="API key per endpoint custom (es. 'EMPTY' per SGLang locale)",
    )
    p.add_argument(
        "--model-id-override",
        default=None,
        help="override openrouter_id da models.yaml (es. 'Qwen/Qwen3.5-9B')",
    )
    p.add_argument(
        "--extra-body",
        default=None,
        help="JSON extra_body inviato a ogni request (es. SGLang reasoning kwargs)",
    )
    p.add_argument(
        "--model-name-override",
        default=None,
        help="override del campo `model_name` nello schema output (default = --model alias)",
    )
    p.add_argument(
        "--exclude-protocols",
        default=None,
        help="comma-sep evaluation_protocol_id da escludere (es. 'llm_judge_factual,rubric_judge')",
    )
    p.add_argument(
        "--max-budget",
        type=float,
        default=None,
        help="Hard cap (USD) sul cost cumulato. Abort + cancel pending tasks se superato.",
    )
    return p.parse_args(argv)


def main() -> None:
    args = parse_args()
    dims = [d.strip() for d in args.dimensions.split(",") if d.strip()]
    extra_body = None
    if args.extra_body:
        extra_body = json.loads(args.extra_body)
    exclude_protocols = None
    if args.exclude_protocols:
        exclude_protocols = {p.strip() for p in args.exclude_protocols.split(",") if p.strip()}
    asyncio.run(
        run(
            model_alias=args.model,
            dimensions=dims,
            limit_per_dim=args.limit_per_dim,
            output=args.output,
            concurrency=args.concurrency,
            reasoning=not args.no_reasoning,
            dataset_path=args.dataset,
            endpoint_url=args.endpoint_url,
            endpoint_key=args.endpoint_key,
            model_id_override=args.model_id_override,
            extra_body=extra_body,
            model_name_override=args.model_name_override,
            exclude_protocols=exclude_protocols,
            max_budget=args.max_budget,
        )
    )


if __name__ == "__main__":
    main()
