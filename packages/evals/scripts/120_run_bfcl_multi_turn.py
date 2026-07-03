#!/usr/bin/env python3
"""120 - Inference + grading multi-turn BFCL (scripted, no LLM user-sim).

Flusso per ogni task:
  1. Carica `initial_config` e istanzia le `involved_classes` (env mock).
  2. Per ogni turn in `question`:
     - Costruisci messages con chat history + question[turn] (lista user messages)
     - Loop interno (max `--max-iter` step):
       - Chiama il modello target via OpenRouterClient
       - Se la response contiene chiamata Python parsabile (`ast_parse`):
         * Esegui le call su env mock (`execute_multi_turn_func_call`)
         * Aggiungi le call e i risultati a chat history
         * Continua il loop interno
       - Altrimenti (plain text): termina il turn (fine inner loop)
  3. A fine task: chiama `multi_turn_checker` per validare lo state finale.
  4. Salva una riga graded (formato compatibile `110_grade_inference` output).

Output JSONL (una riga per task):
  - query_id, dimension, evaluation_protocol_id (= "tool_call_match"),
  - model_raw_response: ultima risposta del modello,
  - model_result_list_decoded: trajectory completa,
  - correct: bool|None, grader_meta: dict con state_match per turn

Usage:
  python scripts/120_run_bfcl_multi_turn.py --model qwen3.5-9b \\
      --output data/inference/qwen9b/multi_turn.jsonl --limit 5
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from brick_evals.graders.bfcl_grader import (  # noqa: E402
    AVAILABLE as BFCL_AVAILABLE,
)
from brick_evals.graders.bfcl_grader import (  # noqa: E402
    extract_calls,
)
from brick_evals.io_utils import configs_dir, load_jsonl, load_yaml, utc_now_iso  # noqa: E402
from brick_evals.openrouter_client import OpenRouterClient  # noqa: E402

# Stub model_config viene applicato da bfcl_grader: importing più moduli BFCL sicuro.
sys.path.insert(0, str(ROOT / "external" / "bfcl" / "berkeley-function-call-leaderboard"))

from bfcl_eval.eval_checker.multi_turn_eval.multi_turn_checker import (  # noqa: E402
    multi_turn_checker,
)
from bfcl_eval.eval_checker.multi_turn_eval.multi_turn_utils import (  # noqa: E402
    execute_multi_turn_func_call,
)

# Per multi-turn il response deve contenere SOLO la chiamata Python o "DONE".
# DONE indica al runtime che il modello ha finito il turn (non ha più tool da chiamare).
MULTI_TURN_SYSTEM_PROMPT = """You are a function-calling assistant operating in a multi-turn environment.

For EACH user request, you must:
  1. Decide which function(s) to invoke (or none).
  2. Output ONLY a Python-style expression with the call(s): nothing else, no prose, no markdown fences:
       - single call:     fn(arg1=value1, arg2=value2)
       - sequence:        [fn1(...), fn2(...)]
  3. After observing the tool result(s), either:
       - Issue more calls (same format), OR
       - Reply with exactly: DONE  (when you've completed the user's request for this turn)

Rules:
  - Never invent functions. Use only those listed in the tool catalog below.
  - Never include prose, explanations, or markdown: output only the Python expression or `DONE`.
  - Stay deterministic and concise.

Tool catalog (signatures for the available functions across the involved classes):
```
{tool_catalog}
```
"""


# --- Tool catalog --------------------------------------------------------


def _build_tool_catalog(involved_classes: list[str]) -> str:
    """Crea un breve catalogo delle funzioni esposte dalle classi env, leggendo
    direttamente le docstring delle implementazioni."""
    import importlib
    import inspect

    from bfcl_eval.constants.executable_backend_config import (  # type: ignore
        CLASS_FILE_PATH_MAPPING,
    )

    lines: list[str] = []
    for class_name in involved_classes:
        module_name = CLASS_FILE_PATH_MAPPING.get(class_name)
        if not module_name:
            lines.append(f"# {class_name}: (no path)")
            continue
        try:
            mod = importlib.import_module(module_name)
            cls = getattr(mod, class_name)
            inst = cls()
            lines.append(f"# {class_name}")
            for name, method in inspect.getmembers(inst, predicate=inspect.ismethod):
                if name.startswith("_"):
                    continue
                try:
                    sig = str(inspect.signature(method))
                except (TypeError, ValueError):
                    sig = "(...)"
                lines.append(f"{name}{sig}")
        except Exception as e:
            lines.append(f"# {class_name}: (introspection failed: {type(e).__name__})")
    return "\n".join(lines)


# --- Inference loop ------------------------------------------------------


def _parse_model_response(content: str) -> tuple[list[str] | None, str]:
    """Estrae le call_string Python dall'output del modello.

    Returns:
        (call_strings, parse_mode) dove:
          - call_strings = lista di "fn(a=1)" Python-style (per execute_multi_turn_func_call)
            None se il modello non ha emesso chiamate parsabili.
          - parse_mode = "DONE" se il modello ha terminato, "calls" se ha emesso call,
            "none" altrimenti.
    """
    if content is None:
        return None, "none"
    txt = content.strip()
    if not txt:
        return None, "none"
    if txt.upper() == "DONE":
        return None, "DONE"

    # Prova prima a estrarre call via bfcl_grader parser (gestisce code block, tag, ecc.)
    decoded, _ = extract_calls(txt)
    if decoded is None:
        return None, "none"

    # Riconverti la lista decoded -> lista di stringhe Python (formato per execute_multi_turn_func_call)
    call_strings: list[str] = []
    for d in decoded:
        for fn_name, args in d.items():
            kwargs_str = ", ".join(f"{k}={repr(v)}" for k, v in args.items())
            call_strings.append(f"{fn_name}({kwargs_str})")
    return call_strings, "calls"


async def run_single_task(
    *,
    client: OpenRouterClient,
    task: dict,
    model_alias: str,
    model_id: str,
    max_iter: int,
    max_tokens: int,
    sem: asyncio.Semaphore,
    extra_body: dict | None = None,
) -> dict:
    """Esegue inference multi-turn su un singolo task, poi grada."""
    test_entry_id = task["id"]
    category = task["_category"]  # es. "multi_turn_base"
    involved_classes = task["involved_classes"]
    initial_config = task["initial_config"]
    questions: list[list[dict]] = task["question"]
    ground_truth: list[list[str]] = task["ground_truth"]

    tool_catalog = _build_tool_catalog(involved_classes)
    system_msg = {"role": "system", "content": MULTI_TURN_SYSTEM_PROMPT.format(tool_catalog=tool_catalog)}

    chat_history: list[dict] = [system_msg]
    model_result_list_decoded: list[list[list[str]]] = []
    last_response_content = ""
    total_iter = 0
    truncated = False
    acc_cost = 0.0
    acc_input_tokens = 0
    acc_completion_tokens = 0
    acc_reasoning_tokens = 0
    acc_latency_ms = 0
    api_calls = 0

    async with sem:
        for _turn_index, turn_messages in enumerate(questions):
            # Aggiungi user messages del turn corrente alla chat history
            chat_history.extend(turn_messages)
            steps_this_turn: list[list[str]] = []

            for step in range(max_iter):
                total_iter += 1
                result = await client.chat(
                    model=model_id,
                    messages=chat_history,
                    temperature=0.0,
                    max_tokens=max_tokens,
                    top_p=1.0,
                    reasoning=False,
                    extra_body=extra_body,
                )
                api_calls += 1
                acc_cost += result.cost or 0.0
                acc_input_tokens += result.prompt_tokens
                acc_completion_tokens += result.completion_tokens
                acc_reasoning_tokens += result.reasoning_tokens
                acc_latency_ms += result.latency_ms
                if result.error:
                    return _make_failure(
                        task,
                        category,
                        f"inference error: {result.error}",
                        model_alias=model_alias,
                        model_id=model_id,
                        decoded=model_result_list_decoded,
                    )
                last_response_content = result.content or ""
                # Append assistant content to chat history (anche se vuoto)
                chat_history.append({"role": "assistant", "content": last_response_content})

                calls, mode = _parse_model_response(last_response_content)
                if mode == "DONE" or mode == "none":
                    break  # fine turn corrente
                if calls is None:
                    break

                # Esegui call su env (stato persistente fra turn / step via globals())
                try:
                    exec_results, _ = execute_multi_turn_func_call(
                        func_call_list=calls,
                        initial_config=initial_config,
                        involved_classes=involved_classes,
                        model_name=model_alias,
                        test_entry_id=test_entry_id,
                        long_context=("long_context" in category or "composite" in category),
                        is_evaL_run=False,
                    )
                except Exception as e:  # noqa: BLE001
                    exec_results = [f"Error during execution: {type(e).__name__}: {e}"]

                steps_this_turn.append(calls)
                # Append tool execution feedback come messaggio user (formato BFCL ufficiale)
                feedback = "\n".join(f"Result of `{c}`: {r}" for c, r in zip(calls, exec_results, strict=False))
                chat_history.append({"role": "user", "content": feedback})

                if step == max_iter - 1:
                    truncated = True

            model_result_list_decoded.append(steps_this_turn)

    # Grading: chiama multi_turn_checker
    try:
        check = multi_turn_checker(
            multi_turn_model_result_list_decoded=model_result_list_decoded,
            multi_turn_ground_truth_list=ground_truth,
            test_entry=task,
            test_category=category,
            model_name=model_alias,
        )
        correct = bool(check.get("valid"))
        grader_meta = {
            "category": category,
            "n_turns": len(questions),
            "iter_total": total_iter,
            "truncated_inner_loop": truncated,
            "checker_error_message": check.get("error_message"),
            "checker_error_type": check.get("error_type"),
            "checker_details": check.get("details"),
            "model_result_list_decoded": model_result_list_decoded,
        }
    except Exception as e:  # noqa: BLE001
        correct = False
        grader_meta = {
            "category": category,
            "n_turns": len(questions),
            "iter_total": total_iter,
            "reason": "multi_turn_checker raised",
            "error": f"{type(e).__name__}: {str(e)[:200]}",
            "model_result_list_decoded": model_result_list_decoded,
        }

    return {
        "query_id": task["id"],
        "model_name": model_alias,
        "model_id_real": model_id,
        "dimension": "planning_agentic",
        "evaluation_protocol_id": "tool_call_match",
        "model_raw_thinking_output": None,
        "model_raw_response": last_response_content,
        "correct": correct,
        "grader_meta": grader_meta,
        "iter_total": total_iter,
        "api_calls": api_calls,
        "input_tokens": acc_input_tokens,
        "completion_tokens": acc_completion_tokens,
        "reasoning_tokens": acc_reasoning_tokens,
        "cost": acc_cost,
        "latency_ms": acc_latency_ms,
        "attempt": 1,
        "error": None,
        "finish_reason": "truncated" if truncated else "DONE",
        "params": {
            "temperature": 0.0,
            "max_tokens": max_tokens,
            "max_iter": max_iter,
            "top_p": 1.0,
            "reasoning": False,
        },
        "timestamp": utc_now_iso(),
    }


def _make_failure(task: dict, category: str, reason: str, *, model_alias: str, model_id: str, decoded: list) -> dict:
    return {
        "query_id": task["id"],
        "model_name": model_alias,
        "model_id_real": model_id,
        "dimension": "planning_agentic",
        "evaluation_protocol_id": "tool_call_match",
        "model_raw_thinking_output": None,
        "model_raw_response": "",
        "correct": None,
        "grader_meta": {"category": category, "reason": reason, "model_result_list_decoded": decoded},
        "api_calls": 0,
        "input_tokens": 0,
        "completion_tokens": 0,
        "reasoning_tokens": 0,
        "cost": 0.0,
        "latency_ms": 0,
        "attempt": 1,
        "error": reason,
        "finish_reason": "error",
        "params": None,
        "timestamp": utc_now_iso(),
    }


# --- Orchestration --------------------------------------------------------


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


async def main_async(args: argparse.Namespace) -> int:
    if not BFCL_AVAILABLE:
        print("[FAIL] BFCL ast_checker not available")
        return 1

    raw_path = ROOT / "data" / "raw" / "bfcl_v4_multi_turn.jsonl"
    if not raw_path.exists():
        print(f"[FAIL] {raw_path} not found. Run scripts/10c_clone_bfcl_multi_turn.py first.")
        return 1

    tasks = list(load_jsonl(raw_path))
    if args.limit:
        tasks = tasks[: args.limit]
    print(f"[run_multi_turn] loaded {len(tasks)} tasks")

    mcfg = load_model_config(args.model)
    model_id = args.model_id_override or mcfg["openrouter_id"]
    print(f"[run_multi_turn] model={args.model} -> {model_id}")
    if args.endpoint_url:
        print(f"[run_multi_turn] endpoint={args.endpoint_url} key={'EMPTY' if args.endpoint_key == 'EMPTY' else 'SET'}")

    args.output.parent.mkdir(parents=True, exist_ok=True)
    # Resume: skip già processati
    done_ids: set[str] = set()
    if args.output.exists():
        for r in load_jsonl(args.output):
            done_ids.add(r["query_id"])
    todo = [t for t in tasks if t["id"] not in done_ids]
    print(f"[run_multi_turn] todo={len(todo)} (already done={len(done_ids)})")

    # Baseline cost: somma cost dei record già presenti (resume) per budget cap accurato
    baseline_cost = 0.0
    if args.output.exists():
        for r in load_jsonl(args.output):
            baseline_cost += r.get("cost") or 0.0
    if args.max_budget:
        print(f"[run_multi_turn] budget cap=${args.max_budget:.2f} | baseline=${baseline_cost:.4f}")

    sem = asyncio.Semaphore(args.concurrency)
    cost_acc = 0.0
    aborted = False
    client_kwargs: dict = {}
    if args.endpoint_url:
        client_kwargs["base_url"] = args.endpoint_url
    if args.endpoint_key:
        client_kwargs["api_key"] = args.endpoint_key
    extra_body = json.loads(args.extra_body) if args.extra_body else None
    if extra_body:
        print(f"[run_multi_turn] extra_body={extra_body}")
    async with OpenRouterClient(**client_kwargs) as client:
        tasks_async = [
            asyncio.create_task(
                run_single_task(
                    client=client,
                    task=task,
                    model_alias=args.model,
                    model_id=model_id,
                    max_iter=args.max_iter,
                    max_tokens=args.max_tokens,
                    sem=sem,
                    extra_body=extra_body,
                )
            )
            for task in todo
        ]
        with open(args.output, "a", encoding="utf-8") as fout:
            for fut in asyncio.as_completed(tasks_async):
                record = await fut
                fout.write(json.dumps(record, ensure_ascii=False, default=str) + "\n")
                fout.flush()
                cost_acc += record.get("cost") or 0.0
                if args.max_budget and (baseline_cost + cost_acc) > args.max_budget:
                    print(
                        f"\n[BUDGET ABORT] cumulative cost ${baseline_cost + cost_acc:.4f} > cap ${args.max_budget:.2f}. "
                        f"Cancelling {sum(1 for t in tasks_async if not t.done())} pending tasks.",
                        flush=True,
                    )
                    aborted = True
                    for t in tasks_async:
                        if not t.done():
                            t.cancel()
                    break
        # Drain delle eccezioni dei task cancellati per evitare warning
        if aborted:
            for t in tasks_async:
                if t.cancelled():
                    continue
                try:
                    await t
                except (asyncio.CancelledError, Exception):
                    pass

    # Report
    results = list(load_jsonl(args.output))
    by_cat: dict[str, list[bool | None]] = {}
    for r in results:
        cat = (r.get("grader_meta") or {}).get("category", "?")
        by_cat.setdefault(cat, []).append(r.get("correct"))

    print("\n[run_multi_turn] DONE")
    for cat, vals in sorted(by_cat.items()):
        graded = [v for v in vals if v is not None]
        if graded:
            print(
                f"  {cat:30s} {sum(graded)}/{len(graded)} ({sum(graded)/len(graded)*100:.1f}%) [skipped={len(vals)-len(graded)}]"
            )
        else:
            print(f"  {cat:30s} N/A (n_graded=0/{len(vals)})")

    total_cost = sum(r.get("cost") or 0.0 for r in results)
    total_in = sum(r.get("input_tokens") or 0 for r in results)
    total_out = sum(r.get("completion_tokens") or 0 for r in results)
    total_api = sum(r.get("api_calls") or 0 for r in results)
    total_latency = sum(r.get("latency_ms") or 0 for r in results)
    print(
        f"  cost_total=${total_cost:.4f}  api_calls={total_api}  "
        f"tokens in={total_in} out={total_out}  cumulative_latency={total_latency/1000:.1f}s"
    )
    return 0


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--model", required=True, help="alias from configs/models.yaml")
    p.add_argument("--output", type=Path, required=True)
    p.add_argument("--limit", type=int, default=None)
    p.add_argument("--max-iter", type=int, default=10, help="inner-loop max steps per turn")
    p.add_argument("--max-tokens", type=int, default=2048)
    p.add_argument("--concurrency", type=int, default=4)
    p.add_argument(
        "--max-budget",
        type=float,
        default=None,
        help="Hard cap (USD) sul cost cumulato. Abort + cancel pending tasks se superato.",
    )
    p.add_argument(
        "--endpoint-url",
        default=None,
        help="Custom OpenAI-compatible base_url (es. http://localhost:30000/v1 per SGLang)",
    )
    p.add_argument("--endpoint-key", default=None, help="API key per endpoint custom (es. 'EMPTY' per SGLang locale)")
    p.add_argument(
        "--model-id-override", default=None, help="Override openrouter_id da models.yaml (es. 'Qwen/Qwen3.5-9B')"
    )
    p.add_argument(
        "--extra-body", default=None, help="JSON extra_body inviato a ogni request (es. vLLM reasoning kwargs)"
    )
    args = p.parse_args()
    raise SystemExit(asyncio.run(main_async(args)))


if __name__ == "__main__":
    main()
