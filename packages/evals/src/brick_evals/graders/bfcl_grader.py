"""Adapt model outputs to the official BFCL AST checker. A minimal model-config stub avoids unrelated provider SDK imports and preserves dotted function names. Parse Python calls, code fences, tool tags and OpenAI JSON. Irrelevance tasks require no calls; other categories use the official checker. Return (correct, metadata), with None for unavailable graders or invalid payloads."""

from __future__ import annotations

import ast
import json
import re
import sys
import types
from pathlib import Path
from typing import Any

# --- Inject BFCL path -------------------------------------------------------

_BFCL_PATH = Path(__file__).resolve().parents[3] / "external" / "bfcl" / "berkeley-function-call-leaderboard"
if _BFCL_PATH.exists() and str(_BFCL_PATH) not in sys.path:
    sys.path.insert(0, str(_BFCL_PATH))


# --- Stub model_config to avoid pulling provider SDKs ----------------------


def _install_model_config_stub() -> None:
    """Install a minimal BFCL model-config mapping before importing the checker. Preserve dotted function names by setting underscore_to_dot=False."""
    mod_name = "bfcl_eval.constants.model_config"
    if mod_name in sys.modules:
        return
    fake = types.ModuleType(mod_name)

    class _FakeCfg:
        underscore_to_dot = False

    class _FakeMap(dict):
        def __getitem__(self, key):  # noqa: D401
            return _FakeCfg()

        def __contains__(self, key):  # noqa: D401
            return True

    fake.MODEL_CONFIG_MAPPING = _FakeMap()
    sys.modules[mod_name] = fake


_install_model_config_stub()


try:
    from bfcl_eval.constants.enums import Language as _BFCLLanguage  # type: ignore
    from bfcl_eval.eval_checker.ast_eval.ast_checker import ast_checker as _ast_checker  # type: ignore

    AVAILABLE = True
    _IMPORT_ERR = ""
except Exception as e:  # pragma: no cover
    AVAILABLE = False
    _IMPORT_ERR = f"{type(e).__name__}: {e}"


# --- Response parsing ------------------------------------------------------

_CODE_BLOCK_PY_RE = re.compile(r"```(?:python|py)?\s*\n(.*?)```", re.DOTALL | re.IGNORECASE)
_CODE_BLOCK_JSON_RE = re.compile(r"```(?:json)?\s*\n(.*?)```", re.DOTALL | re.IGNORECASE)
_TOOLCALL_TAG_RE = re.compile(r"<TOOLCALL>(.*?)</TOOLCALL>", re.DOTALL | re.IGNORECASE)
_JSON_ARRAY_RE = re.compile(r"\[\s*\{.*?\}\s*\]", re.DOTALL)


def _resolve_value(value: ast.AST) -> Any:
    """Subset di `bfcl_eval.model_handler.utils.resolve_ast_by_type` (Python only)."""
    if isinstance(value, ast.Constant):
        return "..." if value.value is Ellipsis else value.value
    if isinstance(value, ast.UnaryOp):
        # numeri negativi: -3, -1.5
        inner = _resolve_value(value.operand)
        if isinstance(value.op, ast.USub) and isinstance(inner, int | float):
            return -inner
        return inner
    if isinstance(value, ast.List):
        return [_resolve_value(v) for v in value.elts]
    if isinstance(value, ast.Tuple):
        return [_resolve_value(v) for v in value.elts]
    if isinstance(value, ast.Dict):
        return {_resolve_value(k): _resolve_value(v) for k, v in zip(value.keys, value.values, strict=False)}
    if isinstance(value, ast.Name):
        # Treat an unresolved variable as a string containing its identifier.
        return value.id
    if isinstance(value, ast.Attribute):
        parts: list[str] = [value.attr]
        cur = value.value
        while isinstance(cur, ast.Attribute):
            parts.append(cur.attr)
            cur = cur.value
        if isinstance(cur, ast.Name):
            parts.append(cur.id)
        return ".".join(reversed(parts))
    # Fallback: prova a estrarre source-like
    try:
        return ast.literal_eval(value)
    except Exception:
        return None


def _resolve_call(elem: ast.Call) -> dict[str, Any]:
    """Converte un `ast.Call` in `{fn_name: {arg: value, ...}}`."""
    func_parts: list[str] = []
    func_part: ast.AST = elem.func
    while isinstance(func_part, ast.Attribute):
        func_parts.append(func_part.attr)
        func_part = func_part.value
    if isinstance(func_part, ast.Name):
        func_parts.append(func_part.id)
    fn_name = ".".join(reversed(func_parts))
    args: dict[str, Any] = {}
    for kw in elem.keywords:
        if kw.arg is None:
            continue  # BFCL does not support expanded keyword arguments.
        args[kw.arg] = _resolve_value(kw.value)
    return {fn_name: args}


def _ast_parse_python(text: str) -> list[dict[str, Any]]:
    """Parse a Python function call or list of calls into BFCL dictionaries. Raise ValueError for invalid syntax."""
    cleaned = text.strip().strip("'").strip('"').strip()
    parsed = ast.parse(cleaned, mode="eval")
    body = parsed.body
    out: list[dict[str, Any]] = []
    if isinstance(body, ast.Call):
        out.append(_resolve_call(body))
    elif isinstance(body, ast.List | ast.Tuple):
        for elem in body.elts:
            if not isinstance(elem, ast.Call):
                raise ValueError(f"non-call element in list: {ast.dump(elem)}")
            out.append(_resolve_call(elem))
    else:
        raise ValueError(f"top-level expression is not a Call: {type(body).__name__}")
    return out


def _from_openai_tool_calls(obj: Any) -> list[dict[str, Any]] | None:
    """Converte formato OpenAI `[{"name": "fn", "arguments": {...}}]` o
    `{"tool_calls": [{"function": {"name": ..., "arguments": "..."}}]}` in BFCL.
    """
    if isinstance(obj, dict) and "tool_calls" in obj:
        obj = obj["tool_calls"]
    if not isinstance(obj, list):
        return None
    out: list[dict[str, Any]] = []
    for c in obj:
        if not isinstance(c, dict):
            return None
        # OpenAI shape: {"function": {"name": ..., "arguments": ...}}
        if "function" in c and isinstance(c["function"], dict):
            fn = c["function"].get("name")
            args = c["function"].get("arguments")
        else:
            fn = c.get("name")
            args = c.get("arguments")
        if not fn:
            return None
        if isinstance(args, str):
            try:
                args = json.loads(args)
            except Exception:
                return None
        if args is None:
            args = {}
        if not isinstance(args, dict):
            return None
        out.append({fn: args})
    return out


def extract_calls(response: str) -> tuple[list[dict[str, Any]] | None, dict[str, Any]]:
    """Try supported model-output call formats. Return calls and parser metadata, or None when no usable calls are found."""
    meta: dict[str, Any] = {"strategy": None}
    if not isinstance(response, str):
        return None, {"strategy": None, "reason": "non-string response"}
    txt = response.strip()
    if not txt:
        return None, {"strategy": None, "reason": "empty response"}

    # 1) <TOOLCALL>...</TOOLCALL> tag (official BFCL format for many models)
    m = _TOOLCALL_TAG_RE.search(txt)
    if m:
        inner = m.group(1).strip()
        try:
            calls = _ast_parse_python(inner)
            meta["strategy"] = "toolcall_tag_python"
            return calls, meta
        except Exception:
            pass
        try:
            obj = json.loads(inner)
            ooai = _from_openai_tool_calls(obj)
            if ooai is not None:
                meta["strategy"] = "toolcall_tag_openai"
                return ooai, meta
        except Exception:
            pass

    # Parse calls inside a Python code fence.
    py_blocks = _CODE_BLOCK_PY_RE.findall(txt)
    for blk in reversed(py_blocks):  # Try the last block first.
        candidate = blk.strip()
        # Remove assignments such as result = fn(...).
        candidate = re.sub(r"^\s*\w+\s*=\s*", "", candidate, flags=re.MULTILINE)
        try:
            calls = _ast_parse_python(candidate)
            meta["strategy"] = "py_block"
            return calls, meta
        except Exception:
            pass

    # 3) JSON code block ```json ... ```
    json_blocks = _CODE_BLOCK_JSON_RE.findall(txt)
    for blk in reversed(json_blocks):
        try:
            obj = json.loads(blk.strip())
            ooai = _from_openai_tool_calls(obj)
            if ooai is not None:
                meta["strategy"] = "json_block_openai"
                return ooai, meta
        except Exception:
            pass

    # 4) JSON array inline `[{"name": ...}]`
    m = _JSON_ARRAY_RE.search(txt)
    if m:
        try:
            obj = json.loads(m.group(0))
            ooai = _from_openai_tool_calls(obj)
            if ooai is not None:
                meta["strategy"] = "json_inline_openai"
                return ooai, meta
        except Exception:
            pass

    # 5) AST-parse diretto del testo (response = pura chiamata Python)
    try:
        calls = _ast_parse_python(txt)
        meta["strategy"] = "raw_python"
        return calls, meta
    except Exception:
        pass

    # Try parsing a call on the last line alone.
    last_line = txt.splitlines()[-1].strip()
    if "(" in last_line and last_line.endswith(")"):
        try:
            calls = _ast_parse_python(last_line)
            meta["strategy"] = "last_line"
            return calls, meta
        except Exception:
            pass

    return None, {"strategy": None, "reason": "no parseable tool call found"}


# --- Public grader ---------------------------------------------------------

# With underscore_to_dot=False, the model label does not change function matching. Allow an explicit environment override of the neutral default.
DEFAULT_MODEL_NAME = "brick-evals-generic"


def grade_bfcl(
    response: str,
    payload: dict[str, Any],
    model_name: str = DEFAULT_MODEL_NAME,
) -> tuple[bool | None, dict[str, Any]]:
    """Grade a single-turn BFCL response against accepted calls and function schemas. Return correctness and metadata; unavailable grading or invalid payloads yields None."""
    if not AVAILABLE:
        return None, {"reason": f"BFCL not available: {_IMPORT_ERR}"}

    category = (payload.get("category") or "").lower()
    bfcl_id = payload.get("id")
    if not category:
        return None, {"reason": "missing category in payload", "id": bfcl_id}

    func_description = payload.get("function_specs") or []
    ground_truth = payload.get("ground_truth_calls") or []

    decoded, parse_meta = extract_calls(response)

    # Irrelevance tasks must not call any function.
    if category == "irrelevance":
        # Nessuna chiamata parsabile -> corretto. Qualunque chiamata -> errato.
        correct = decoded is None or len(decoded) == 0
        return correct, {
            "category": category,
            "id": bfcl_id,
            "parse": parse_meta,
            "decoded_n": 0 if decoded is None else len(decoded),
        }

    # Other categories require at least one call.
    if decoded is None:
        return False, {
            "category": category,
            "id": bfcl_id,
            "reason": "no tool call extracted",
            "parse": parse_meta,
        }

    if not func_description:
        return None, {
            "reason": "missing function_specs in payload",
            "id": bfcl_id,
            "category": category,
        }
    if not ground_truth:
        return None, {
            "reason": "missing ground_truth_calls in payload",
            "id": bfcl_id,
            "category": category,
        }

    try:
        result = _ast_checker(
            func_description,
            decoded,
            ground_truth,
            _BFCLLanguage.PYTHON,
            category,
            model_name,
        )
    except Exception as e:  # noqa: BLE001
        return False, {
            "category": category,
            "id": bfcl_id,
            "reason": "ast_checker raised",
            "error": f"{type(e).__name__}: {str(e)[:200]}",
            "parse": parse_meta,
        }

    valid = bool(result.get("valid"))
    meta = {
        "category": category,
        "id": bfcl_id,
        "parse": parse_meta,
        "checker_error": result.get("error"),
        "checker_error_type": result.get("error_type"),
        "decoded": decoded,
    }
    return valid, meta
