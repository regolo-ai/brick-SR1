"""Grade Python code with the official LiveCodeBench runner in an isolated process. Extract the last code fence, decode private tests and derive functional entrypoints from the payload or starter code. All public and private tests must pass; unavailable grading or absent tests yields None."""

from __future__ import annotations

import base64
import json
import multiprocessing
import pickle
import re
import sys
import zlib
from pathlib import Path
from typing import Any

# Inject LCB external clone into sys.path so we can import the official runner
_EXT = Path(__file__).resolve().parents[3] / "external" / "livecodebench"
if _EXT.exists() and str(_EXT) not in sys.path:
    sys.path.insert(0, str(_EXT))

try:
    # Import lazily-resolvable: solo verifica disponibilita'. La chiamata
    # Execution occurs in the child to isolate reliability_guard.
    from lcb_runner.evaluation.testing_util import run_test as _run_test_probe  # noqa: F401

    AVAILABLE = True
    _IMPORT_ERR = ""
except Exception as e:  # pragma: no cover
    AVAILABLE = False
    _IMPORT_ERR = f"{type(e).__name__}: {e}"


_CODE_BLOCK_RE = re.compile(r"```(?:python|py)?\s*\n(.*?)```", re.DOTALL | re.IGNORECASE)
# Handle an opening Python fence without a closing fence, as in truncated output.
_OPEN_FENCE_RE = re.compile(r"```(?:python|py)?\s*\n(.*)", re.DOTALL | re.IGNORECASE)
_FN_FROM_STARTER_RE = re.compile(r"def\s+(\w+)\s*\(")


def extract_python(response: str) -> str:
    """Extract the last closed Python code fence, then an unclosed fence, then the entire stripped response."""
    if not isinstance(response, str):
        return ""
    matches = _CODE_BLOCK_RE.findall(response)
    if matches:
        return matches[-1].strip()
    m = _OPEN_FENCE_RE.search(response)
    if m:
        return m.group(1).strip()
    return response.strip()


def decompress_private_tests(blob: Any) -> list:
    """Decode LCB private tests from base64, zlib, pickle and optional JSON. Also accept already decoded lists/JSON or missing input."""
    if blob is None or blob == "":
        return []
    if isinstance(blob, list):
        return blob
    if not isinstance(blob, str):
        return []
    # Case 1: plain JSON already decompressed
    try:
        parsed = json.loads(blob)
        if isinstance(parsed, list):
            return parsed
    except Exception:
        pass
    # Case 2: base64, zlib and pickle (LCB v6 format)
    try:
        decoded = base64.b64decode(blob.encode("utf-8"))
        decompressed = zlib.decompress(decoded)
        unpickled = pickle.loads(decompressed)
        if isinstance(unpickled, str):
            return json.loads(unpickled)
        if isinstance(unpickled, list):
            return unpickled
    except Exception:
        pass
    return []


def _derive_fn_name(payload: dict) -> str | None:
    """Read the function name from the payload or derive it from functional starter code."""
    fn = payload.get("fn_name")
    if fn:
        return fn
    pubs = payload.get("public_tests") or []
    is_functional = any(t.get("testtype") == "functional" for t in pubs)
    if not is_functional:
        return None
    starter = payload.get("starter_code") or ""
    # Functional starter code may begin with __init__; skip it when identifying the requested method.
    for m in _FN_FROM_STARTER_RE.finditer(starter):
        name = m.group(1)
        if name != "__init__":
            return name
    return None


def _worker(sample, code, timeout, debug, result, meta_list):
    """Execute run_test in an isolated process because reliability_guard changes global state."""
    # Import inside the isolated child
    import sys as _sys

    if str(_EXT) not in _sys.path:
        _sys.path.insert(0, str(_EXT))
    from lcb_runner.evaluation.testing_util import run_test as _rt

    try:
        res, meta = _rt(sample, test=code, debug=debug, timeout=timeout)
    except Exception as e:
        res = [-5]
        meta = {"error": f"{type(e).__name__}: {str(e)[:300]}"}
    result.append(res)
    meta_list.append(meta)


def _run_isolated(sample: dict, code: str, timeout: int, n_inputs: int) -> tuple[list, dict]:
    """Run LiveCodeBench in a child process. Enforce a global (timeout + 1) * input_count + 5 second deadline; kill timed-out children and mark all tests failed."""
    ctx = multiprocessing.get_context("fork")
    manager = ctx.Manager()
    result = manager.list()
    meta_list = manager.list()
    p = ctx.Process(target=_worker, args=(sample, code, timeout, False, result, meta_list))
    p.start()
    p.join(timeout=(timeout + 1) * n_inputs + 5)
    if p.is_alive():
        p.kill()
        p.join(timeout=2)
    if not list(result):
        return [-1] * n_inputs, {"error": "global timeout / no result"}
    res = result[0]
    meta = meta_list[0] if len(meta_list) > 0 else {}
    if not isinstance(res, list):
        res = [res]
    # LCB sometimes returns numpy bool: coerce
    fixed = []
    for e in res:
        try:
            import numpy as _np

            if isinstance(e, _np.ndarray):
                e = e.item(0)
            if isinstance(e, _np.bool_):
                e = bool(e)
        except Exception:
            pass
        fixed.append(e)
    return fixed, meta


def grade_lcb(response: str, payload: dict, timeout: int = 6) -> tuple[bool | None, dict]:
    """Return correctness and metadata for all public/private tests. Any failed test or execution error is false; unavailable grading or no tests is None."""
    if not AVAILABLE:
        return None, {"reason": f"LCB runner not available: {_IMPORT_ERR}"}

    code = extract_python(response)
    if not code.strip():
        return False, {"reason": "no code extracted from response"}

    public = list(payload.get("public_tests") or [])
    private = decompress_private_tests(payload.get("private_tests"))
    all_tests = public + list(private)
    if not all_tests:
        return None, {"reason": "no tests available"}

    fn_name = _derive_fn_name(payload)

    in_outs: dict[str, Any] = {
        "inputs": [t["input"] for t in all_tests],
        "outputs": [t["output"] for t in all_tests],
    }
    if fn_name:
        in_outs["fn_name"] = fn_name

    sample = {"input_output": json.dumps(in_outs)}

    try:
        results, rt_meta = _run_isolated(sample, code, timeout=timeout, n_inputs=len(all_tests))
    except Exception as e:
        return False, {
            "reason": "isolated runner raised",
            "error": f"{type(e).__name__}: {str(e)[:200]}",
            "n_tests": len(all_tests),
            "fn_name": fn_name,
        }

    n_total = len(all_tests)
    n_passed = sum(1 for r in results if r is True)
    n_failed = sum(1 for r in results if r is False)
    n_error = sum(1 for r in results if isinstance(r, int) and r < 0)
    # LCB short-circuits some failures. Missing test results were not executed and count as failures.
    n_missing = max(0, n_total - len(results))

    all_pass = n_passed == n_total and n_failed == 0 and n_error == 0 and n_missing == 0

    meta = {
        "n_tests": n_total,
        "n_results": len(results),
        "passed": n_passed,
        "failed": n_failed,
        "errored": n_error,
        "missing": n_missing,
        "fn_name": fn_name,
        "code_extracted_len": len(code),
        "runtime_meta": rt_meta,
    }
    return all_pass, meta
