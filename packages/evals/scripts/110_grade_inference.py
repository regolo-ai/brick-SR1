"""Grade Dataset A inference JSONL using the protocol-specific graders. Only final response text is graded; internal reasoning is excluded. Empty responses truncated at the token limit receive correct=None. External LLM judges require explicit --enable-judge. See --help for input/output options."""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

# Load .env if present (for OPENROUTER_KEY etc)
_env_path = ROOT / ".env"
if _env_path.exists():
    for _line in _env_path.read_text().splitlines():
        if "=" in _line and not _line.startswith("#"):
            _k, _v = _line.split("=", 1)
            os.environ.setdefault(_k.strip(), _v.strip().strip('"').strip("'"))

from brick_evals.graders.bfcl_grader import AVAILABLE as BFCL_AVAILABLE  # noqa: E402
from brick_evals.graders.bfcl_grader import grade_bfcl as _grade_bfcl_impl  # noqa: E402
from brick_evals.graders.ifeval_grader import AVAILABLE as IFEVAL_AVAILABLE  # noqa: E402
from brick_evals.graders.ifeval_grader import grade_ifeval as _grade_ifeval_impl  # noqa: E402
from brick_evals.graders.lcb_grader import AVAILABLE as LCB_AVAILABLE  # noqa: E402
from brick_evals.graders.lcb_grader import grade_lcb as _grade_lcb_impl  # noqa: E402
from brick_evals.graders.rubric_judge_grader import AVAILABLE as RUBRIC_AVAILABLE  # noqa: E402
from brick_evals.graders.rubric_judge_grader import grade_rubric as _grade_rubric_impl  # noqa: E402
from brick_evals.graders.simpleqa_grader import grade_simpleqa as _grade_simpleqa_impl  # noqa: E402
from brick_evals.io_utils import load_jsonl, repo_root  # noqa: E402
from brick_evals.openrouter_judge_client import OpenRouterJudgeClient  # noqa: E402

PROGRAMMATIC = {"gsm8k_final_answer", "mcq_letter", "math_equiv", "ifeval_constraint_check"}
CODE_EXEC = {"lcb_unit_test"}
BFCL = {"tool_call_match"}
LLM_JUDGE = {"rubric_judge", "llm_judge_factual"}
NOT_SUPPORTED = {"tool_call_trajectory", "gaia_exact_match"}


# ---------- gsm8k ----------


def grade_gsm8k(response: str, payload: dict) -> tuple[bool | None, dict]:
    expected = str(payload.get("final_answer", "")).strip()
    if not expected:
        return None, {"reason": "no expected final_answer"}
    m = re.findall(r"####\s*(-?\d[\d,]*)", response)
    if m:
        candidate = m[-1].replace(",", "")
    else:
        # Prefer explicit boxed or answer-is markers before broader fallbacks.
        boxed = re.findall(r"\\boxed\{\s*(-?\d[\d,]*\.?\d*)\s*\}", response)
        if boxed:
            candidate = boxed[-1].replace(",", "")
        else:
            tail = response[-300:]
            nums = re.findall(r"-?\d[\d,]*\.?\d*", tail)
            candidate = nums[-1].replace(",", "") if nums else ""
    try:
        return (float(candidate) == float(expected)), {"candidate": candidate, "expected": expected}
    except ValueError:
        return False, {"candidate": candidate, "expected": expected, "reason": "not numeric"}


# ---------- mcq_letter ----------

# MCQ letters are uppercase A-J; do not use IGNORECASE. Match patterns from most to least specific.
_MCQ_PATTERNS = [
    re.compile(r"\\boxed\{\s*([A-J])\s*\}"),
    re.compile(r"\*\*\s*([A-J])\s*\*\*"),
    # Accept punctuation, whitespace or end of string after an explicit answer letter.
    re.compile(r"(?:[Aa]nswer|[Rr]isposta)\s+is\s+[\(\[]?([A-J])(?:[\)\]\.\,\:\;\s]|$)"),
    re.compile(r"(?:[Aa]nswer|[Rr]isposta)\s*[:=]\s*[\(\[]?([A-J])(?:[\)\]\.\,\:\;\s]|$)"),
    # "correct answer is X"
    re.compile(r"correct\s+answer\s+is\s+[\(\[]?([A-J])(?:[\)\]\.\,\:\;\s]|$)"),
    # "(X)" capital letter only
    re.compile(r"\(([A-J])\)"),
]

# Remove name initials followed by uppercase text before matching standalone answer letters.
_NAME_INITIAL_RE = re.compile(r"\b([A-J])\.\s+(?=[A-Z])")
_STANDALONE_LETTER_RE = re.compile(r"(?<![A-Za-z])([A-J])(?![A-Za-z])")


def grade_mcq(response: str, payload: dict) -> tuple[bool | None, dict]:
    expected = str(payload.get("answer_letter", "")).strip().upper()
    if not expected or len(expected) != 1:
        return None, {"reason": "no expected answer_letter"}
    candidate = None
    for pat in _MCQ_PATTERNS:
        matches = pat.findall(response)
        if matches:
            candidate = matches[-1].upper()
            break
    if candidate is None:
        # Apply the standalone-letter fallback only to the tail after removing name initials.
        tail = response[-200:]
        cleaned = _NAME_INITIAL_RE.sub("", tail)
        m = _STANDALONE_LETTER_RE.findall(cleaned)
        if m:
            candidate = m[-1].upper()
    if candidate is None:
        return False, {"expected": expected, "reason": "no letter found"}
    return (candidate == expected), {"candidate": candidate, "expected": expected}


# ---------- math_equiv ----------

_BOXED_RE = re.compile(r"\\boxed\{((?:[^{}]|\{[^{}]*\})*)\}")


def _extract_boxed(text: str) -> str | None:
    m = _BOXED_RE.findall(text)
    if not m:
        return None
    candidate = m[-1].strip()
    # Repeatedly unwrap nested boxed expressions emitted by some models.
    for _ in range(5):
        inner_match = _BOXED_RE.findall(candidate)
        if not inner_match:
            break
        new_candidate = inner_match[-1].strip()
        if new_candidate == candidate:
            break
        candidate = new_candidate
    return candidate


def _normalize_math(s: str) -> str:
    s = s.strip().rstrip(".")
    s = s.replace("\\dfrac", "\\frac").replace("\\tfrac", "\\frac")
    s = s.replace("$", "").replace("\\,", "").replace("\\!", "")
    # Strip unit suffixes in text/mbox with leading whitespace and optional exponents: 5.4 cents becomes 5.4; 864 square inches becomes 864.
    s = re.sub(
        r"\s*\\(?:text|textbf|mbox|mathrm)\{\s+[^}]*\}\s*(?:\^\{?-?\d+\}?)?",
        "",
        s,
    )
    # 2) Degree symbol ^\circ o ^{\circ} (q_03044: "90^\\circ" → "90")
    s = re.sub(r"\s*\^\{?\\circ\}?\s*$", "", s)
    # 3) \frac{X}Y → \frac{X}{Y} per denominator single-char (LaTeX equivalent forms)
    s = re.sub(r"\\frac\{([^{}]+)\}(\w)(?![a-zA-Z\d])", r"\\frac{\1}{\2}", s)
    # 4) Standalone \text{X} (no leading space) → estrai content X
    s = re.sub(r"\\(?:text|textbf|mbox|mathrm)\{([^}]*)\}", r"\1", s)
    s = s.strip()
    # 5) Strip outer parens around single token: "(C)" → "C"
    m = re.match(r"^\(([^()]+)\)$", s)
    if m:
        s = m.group(1).strip()
    # Remove spaces and normalize case for the final comparison.
    s = s.replace(" ", "").lower()
    return s


def grade_math_equiv(response: str, payload: dict) -> tuple[bool | None, dict]:
    expected = str(payload.get("final_answer", "")).strip()
    if not expected:
        return None, {"reason": "no expected final_answer"}
    candidate = _extract_boxed(response)
    if candidate is None:
        # Require explicit final-answer markers; a last-number fallback risks incorrect grading.
        m = re.search(
            r"(?:final\s+answer|answer\s+is)\s*[:=]?\s*\$?([^\s$\\]+)",
            response,
            re.IGNORECASE,
        )
        if m:
            candidate = m.group(1).rstrip(".,;")
        else:
            return False, {"expected": expected, "reason": "no boxed and no explicit final answer"}
    if not candidate:
        return False, {"expected": expected, "reason": "no candidate"}
    cn = _normalize_math(candidate)
    en = _normalize_math(expected)
    if cn == en:
        return True, {"candidate": candidate, "expected": expected, "match": "string"}
    try:
        if abs(float(cn) - float(en)) < 1e-6:
            return True, {"candidate": candidate, "expected": expected, "match": "numeric"}
    except ValueError:
        pass
    try:
        import sympy
        from sympy.parsing.latex import parse_latex

        try:
            ce = parse_latex(candidate)
            ee = parse_latex(expected)
            if sympy.simplify(ce - ee) == 0:
                return True, {"candidate": candidate, "expected": expected, "match": "sympy"}
        except Exception:
            pass
    except ImportError:
        pass
    return False, {"candidate": candidate, "expected": expected, "match": "none"}


# ---------- ifeval ----------


def grade_ifeval(response: str, payload: dict) -> tuple[bool | None, dict]:
    if not IFEVAL_AVAILABLE:
        return None, {"reason": "ifeval registry not available"}
    inst_ids = payload.get("instruction_id_list") or []
    kwargs_list = payload.get("kwargs") or []
    if not inst_ids:
        return None, {"reason": "no instruction_id_list"}
    return _grade_ifeval_impl(response, inst_ids, kwargs_list)


# ---------- lcb ----------


def grade_lcb(response: str, payload: dict, timeout: int = 6) -> tuple[bool | None, dict]:
    if not LCB_AVAILABLE:
        return None, {"reason": "LCB runner not available"}
    return _grade_lcb_impl(response, payload, timeout=timeout)


# ---------- bfcl (tool_call_match, planning_agentic single-turn) ----------


def grade_bfcl(response: str, payload: dict) -> tuple[bool | None, dict]:
    if not BFCL_AVAILABLE:
        return None, {"reason": "BFCL ast_checker not available"}
    return _grade_bfcl_impl(response, payload)


# ---------- rubric_judge (LLM-as-judge per planning_custom + creative_*) ----


def grade_rubric(response: str, payload: dict, query: str) -> tuple[bool | None, dict]:
    if not RUBRIC_AVAILABLE:
        return None, {"reason": "rubric judge not available"}
    return _grade_rubric_impl(response, payload, query=query)


# Grade only model_raw_response. Internal reasoning contains tentative answers and contradictions and must never supply the final answer. Empty responses truncated at the token limit receive correct=None in the main loop.


async def grade_row(
    response: str,
    protocol: str,
    expected: dict,
    *,
    query: str = "",
    thinking: str = "",  # accepted for signature compat but DELIBERATELY UNUSED
    enable_lcb: bool = True,
    enable_judge: bool = False,
    lcb_timeout: int = 6,
    judge_client: OpenRouterJudgeClient | None = None,
    judge_model: str = "openai/gpt-5.4-mini",
    judge_temperature: float = 0.0,
) -> tuple[bool | None, dict]:
    """Grade final response text only. The thinking argument is deliberately ignored. External judge protocols are asynchronous; deterministic graders run synchronously."""
    payload = expected.get("payload", {}) if isinstance(expected, dict) else {}

    if protocol == "gsm8k_final_answer":
        return grade_gsm8k(response, payload)
    if protocol == "mcq_letter":
        return grade_mcq(response, payload)
    if protocol == "math_equiv":
        return grade_math_equiv(response, payload)
    if protocol == "ifeval_constraint_check":
        return grade_ifeval(response, payload)
    if protocol == "lcb_unit_test":
        if not enable_lcb:
            return None, {"reason": "lcb grader disabled (--no-lcb)"}
        return grade_lcb(response, payload, timeout=lcb_timeout)
    if protocol in BFCL:
        return grade_bfcl(response, payload)
    if protocol == "rubric_judge":
        if not enable_judge:
            return None, {"reason": "rubric_judge not enabled (use --enable-judge)"}
        return await _grade_rubric_impl(
            response,
            payload,
            query=query,
            judge_client=judge_client,
            judge_model=judge_model,
            judge_temperature=judge_temperature,
        )
    if protocol == "llm_judge_factual":
        if not enable_judge:
            return None, {"reason": "llm_judge_factual not enabled (use --enable-judge)"}
        return await _grade_simpleqa_impl(
            response,
            payload,
            query=query,
            judge_client=judge_client,
            judge_model=judge_model,
            judge_temperature=judge_temperature,
        )
    if protocol in LLM_JUDGE:
        if not enable_judge:
            return None, {"reason": "llm_judge not enabled"}
        return None, {"reason": f"unhandled LLM_JUDGE protocol: {protocol}"}
    if protocol in NOT_SUPPORTED:
        return None, {"reason": "protocol excluded (planning_agentic family)"}
    return None, {"reason": f"unknown protocol: {protocol}"}


async def _process_row(
    row: dict,
    eval_index: dict,
    *,
    enable_lcb: bool,
    enable_judge: bool,
    lcb_timeout: int,
    judge_client,
    judge_model: str,
    judge_temperature: float,
    writer_lock: asyncio.Lock,
    fout,
    stats: dict,
) -> None:
    """Process single row: grade + write under lock + update stats."""
    qid = row["query_id"]
    ev = eval_index.get(qid)
    response = row.get("model_raw_response") or ""
    finish = row.get("finish_reason")
    protocol = row.get("evaluation_protocol_id")

    if ev is None:
        row["correct"] = None
        row["grader_meta"] = {"reason": f"qid {qid} not in dataset"}
        stats["skipped_reasons"]["qid_not_found"] += 1
    elif row.get("error"):
        row["correct"] = None
        row["grader_meta"] = {"reason": "inference error", "error": row["error"]}
        stats["skipped_reasons"]["inference_error"] += 1
    else:
        expected = ev.get("expected_answer", {})
        thinking = row.get("model_raw_thinking_output") or ""
        query = ev.get("query") or ""
        correct, meta = await grade_row(
            response,
            protocol,
            expected,
            query=query,
            thinking=thinking,
            enable_lcb=enable_lcb,
            enable_judge=enable_judge,
            lcb_timeout=lcb_timeout,
            judge_client=judge_client,
            judge_model=judge_model,
            judge_temperature=judge_temperature,
        )
        if finish == "length" and not response.strip() and not meta.get("from_thinking"):
            row["correct"] = None
            row["grader_meta"] = {
                "reason": "truncation_empty: finish_reason=length, no response, thinking has no parseable answer"
            }
            stats["skipped_reasons"]["truncation_empty"] += 1
        else:
            row["correct"] = correct
            row["grader_meta"] = meta
            if correct is None:
                stats["skipped_reasons"][meta.get("reason", "unknown")] += 1

    stats["by_proto_correct"][protocol].append(row["correct"])
    stats["by_dim_correct"][row.get("dimension", "?")].append(row["correct"])

    _m = row.get("grader_meta") or {}
    stats["judge_cost"] = stats.get("judge_cost", 0.0) + (_m.get("judge_cost_usd") or 0.0)

    async with writer_lock:
        fout.write(json.dumps(row, ensure_ascii=False, separators=(",", ":")) + "\n")
        fout.flush()


async def _amain() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--inference", type=Path, required=True, help="inference JSONL output")
    p.add_argument("--output", type=Path, required=True, help="graded JSONL output (append-resume safe)")
    p.add_argument(
        "--dataset",
        type=Path,
        default=repo_root() / "data" / "final" / "evaluation_parameters_full.jsonl",
    )
    p.add_argument("--no-lcb", action="store_true", help="disable lcb_unit_test grader")
    p.add_argument("--enable-judge", action="store_true", help="enable LLM-judge protocols")
    p.add_argument("--lcb-timeout", type=int, default=6, help="per-test timeout (s) LCB grader")
    p.add_argument("--judge-model", default="openai/gpt-5.4-mini", help="OpenRouter model slug")
    p.add_argument("--judge-temperature", type=float, default=0.0)
    p.add_argument("--judge-concurrency", type=int, default=4, help="async concurrency per LLM judge")
    p.add_argument("--limit", type=int, default=None, help="grade only first N rows (smoke test)")
    p.add_argument(
        "--max-budget",
        type=float,
        default=None,
        help="Hard cap (USD) sul costo cumulato dei judge. Abort quando superato.",
    )
    args = p.parse_args()

    enable_lcb = (not args.no_lcb) and LCB_AVAILABLE

    print(f"[grader] inference={args.inference}")
    print(f"[grader] dataset={args.dataset}")
    print(f"[grader] output={args.output}")
    print(
        f"[grader] enable_lcb={enable_lcb}  enable_judge={args.enable_judge}  judge_model={args.judge_model}  conc={args.judge_concurrency}"
    )

    # Keep only query and expected_answer in the index to reduce memory usage.
    eval_index: dict[str, dict] = {}
    for row in load_jsonl(args.dataset):
        eval_index[row["query_id"]] = {
            "query": row.get("query", ""),
            "expected_answer": row.get("expected_answer", {}),
        }
    print(f"[grader] dataset rows indexed (slim): {len(eval_index)}")

    args.output.parent.mkdir(parents=True, exist_ok=True)

    # === Append-resume: load existing graded qids ===
    done_qids: set[str] = set()
    if args.output.exists():
        with open(args.output, encoding="utf-8") as fexist:
            for line in fexist:
                line = line.strip()
                if not line:
                    continue
                try:
                    d = json.loads(line)
                    done_qids.add(d["query_id"])
                except (json.JSONDecodeError, KeyError):
                    # Corrupted/partial line: drop everything after this and rewrite
                    pass
        # Sanity: if last line was partial, we may have parsed N-1 valid rows.
        # We rewrite the file with just valid rows + truncate.
        if done_qids:
            valid_rows = []
            with open(args.output, encoding="utf-8") as fexist:
                for line in fexist:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        valid_rows.append(json.loads(line))
                    except json.JSONDecodeError:
                        break
            with open(args.output, "w", encoding="utf-8") as ftmp:
                for r in valid_rows:
                    ftmp.write(json.dumps(r, ensure_ascii=False, separators=(",", ":")) + "\n")
            done_qids = {r["query_id"] for r in valid_rows}
    print(f"[grader] resume: {len(done_qids)} qid already graded, skip")

    # Conta solo righe da gradare (no upfront load)
    total_to_grade = 0
    with open(args.inference, encoding="utf-8") as fin:
        for line in fin:
            line = line.strip()
            if not line:
                continue
            row = json.loads(line)
            if row["query_id"] in done_qids:
                continue
            total_to_grade += 1
            if args.limit is not None and total_to_grade >= args.limit:
                break
    print(f"[grader] rows_to_grade={total_to_grade}")

    stats = {
        "by_proto_correct": defaultdict(list),
        "by_dim_correct": defaultdict(list),
        "skipped_reasons": Counter(),
        "completed": 0,
        "judge_cost": 0.0,
        "aborted": False,
    }
    if args.max_budget:
        print(f"[grader] budget cap=${args.max_budget:.2f} (judge cost)")

    writer_lock = asyncio.Lock()

    async def _row_stream():
        """Yield rows to grade, streaming from disk (no upfront list)."""
        count = 0
        with open(args.inference, encoding="utf-8") as fin:
            for line in fin:
                line = line.strip()
                if not line:
                    continue
                row = json.loads(line)
                if row["query_id"] in done_qids:
                    continue
                yield row
                count += 1
                if args.limit is not None and count >= args.limit:
                    break

    async def _worker(queue: asyncio.Queue, judge_client, fout, worker_id: int):
        """Execute run_test in an isolated process because reliability_guard changes global state."""
        while True:
            row = await queue.get()
            if row is None:
                queue.task_done()
                return
            if stats.get("aborted"):
                queue.task_done()
                continue
            try:
                await _process_row(
                    row,
                    eval_index,
                    enable_lcb=enable_lcb,
                    enable_judge=args.enable_judge,
                    lcb_timeout=args.lcb_timeout,
                    judge_client=judge_client,
                    judge_model=args.judge_model,
                    judge_temperature=args.judge_temperature,
                    writer_lock=writer_lock,
                    fout=fout,
                    stats=stats,
                )
                stats["completed"] += 1
                if args.max_budget and stats["judge_cost"] > args.max_budget and not stats["aborted"]:
                    stats["aborted"] = True
                    print(
                        f"\n[BUDGET ABORT] judge cost ${stats['judge_cost']:.4f} "
                        f"> cap ${args.max_budget:.2f}. Stopping (in-flight rows finish).",
                        flush=True,
                    )
                if stats["completed"] % 50 == 0:
                    print(f"  [{stats['completed']}/{total_to_grade}] graded")
            finally:
                # row reference can be released as soon as task done
                del row
                queue.task_done()

    # Open output in append mode
    with open(args.output, "a", encoding="utf-8") as fout:
        if args.enable_judge:
            async with OpenRouterJudgeClient(model=args.judge_model) as judge_client:
                queue: asyncio.Queue = asyncio.Queue(maxsize=args.judge_concurrency * 2)
                workers = [
                    asyncio.create_task(_worker(queue, judge_client, fout, i)) for i in range(args.judge_concurrency)
                ]
                # Stream producer rows until a budget cancellation occurs.
                async for row in _row_stream():
                    if stats.get("aborted"):
                        break
                    await queue.put(row)
                # Sentinels terminate workers
                for _ in workers:
                    await queue.put(None)
                await asyncio.gather(*workers)
        else:
            # No judge: sequential streaming, programmatic graders are fast
            async for row in _row_stream():
                await _process_row(
                    row,
                    eval_index,
                    enable_lcb=enable_lcb,
                    enable_judge=False,
                    lcb_timeout=args.lcb_timeout,
                    judge_client=None,
                    judge_model=args.judge_model,
                    judge_temperature=args.judge_temperature,
                    writer_lock=writer_lock,
                    fout=fout,
                    stats=stats,
                )
                stats["completed"] += 1
                if stats["completed"] % 100 == 0:
                    print(f"  [{stats['completed']}/{total_to_grade}] graded")

    # === Stats output ===
    def acc(values: list[bool | None]) -> str:
        graded = [v for v in values if v is not None]
        if not graded:
            return f"N/A (n_graded=0/{len(values)})"
        return f"{sum(graded)}/{len(graded)} ({sum(graded) / len(graded) * 100:.1f}%) [skipped={len(values) - len(graded)}/{len(values)}]"

    total = sum(len(v) for v in stats["by_proto_correct"].values())
    print()
    print(f"[grader] DONE rows_processed={total} (skipped existing={len(done_qids)})")
    print("  by_protocol:")
    for proto, vals in sorted(stats["by_proto_correct"].items()):
        print(f"    {proto:30s} {acc(vals)}")
    print("  by_dimension:")
    for dim, vals in sorted(stats["by_dim_correct"].items()):
        print(f"    {dim:25s} {acc(vals)}")
    if stats["skipped_reasons"]:
        print("  skipped_reasons:")
        for r, n in stats["skipped_reasons"].most_common():
            print(f"    {n:4d}  {r}")

    # Cost summary (judge calls only)
    if args.enable_judge:
        # Re-read output to aggregate judge cost
        total_cost = 0.0
        total_in = total_out = 0
        with open(args.output, encoding="utf-8") as f:
            for line in f:
                if not line.strip():
                    continue
                d = json.loads(line)
                meta = d.get("grader_meta") or {}
                total_cost += meta.get("judge_cost_usd", 0) or 0
                total_in += meta.get("judge_input_tokens", 0) or 0
                total_out += meta.get("judge_output_tokens", 0) or 0
        print(f"\n[grader] judge cost: ${total_cost:.4f}  in={total_in}  out={total_out}")


def main() -> None:
    asyncio.run(_amain())


if __name__ == "__main__":
    main()
