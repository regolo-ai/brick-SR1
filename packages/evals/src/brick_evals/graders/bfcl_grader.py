"""BFCL grader wrapper sopra `bfcl_eval.eval_checker.ast_eval.ast_checker`.

Implementa `evaluation_protocol_id == "tool_call_match"` (Dim 6 planning_agentic).

Strategia:
1. Inietta `external/bfcl/berkeley-function-call-leaderboard/` in `sys.path`.
2. Bypassa `bfcl_eval.constants.model_config` con uno stub per evitare la catena
   di import dei vari SDK provider (anthropic/cohere/mistralai/...) che non ci
   servono: del MODEL_CONFIG_MAPPING usiamo solo l'attributo `underscore_to_dot`
   in `convert_func_name`.
3. Estrae la chiamata Python-style dal `response` del modello (code block, tag
   <TOOLCALL>, JSON OpenAI-style, o testo nudo) e la converte nel formato AST
   atteso da BFCL: `list[dict]` di `{"fn_name": {"arg": value, ...}}`.
4. Per la categoria `irrelevance` (no tool da chiamare) accetta come corretto
   solo l'output vuoto.
5. Per `simple/multiple/parallel/parallel_multiple` delega ad `ast_checker`.

Output: `(correct: bool|None, meta: dict)`.
"""

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
    """Stub `bfcl_eval.constants.model_config` BEFORE ast_checker imports it.

    `ast_checker.convert_func_name` legge `MODEL_CONFIG_MAPPING[m].underscore_to_dot`.
    Forziamo `underscore_to_dot=False` per ogni modello: i nomi funzione contenenti
    "." restano intatti, che è quello che BFCL fa per i modelli non-OAI (e per
    gli output `ast_parse`-d non c'è alcun bisogno di conversione).
    """
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
        # variabile non risolvibile: la trattiamo come stringa con il suo id
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
            continue  # **kwargs non supportato in BFCL
        args[kw.arg] = _resolve_value(kw.value)
    return {fn_name: args}


def _ast_parse_python(text: str) -> list[dict[str, Any]]:
    """Parse `fn(a=1)` o `[fn1(a=1), fn2(b=2)]` in lista di dict BFCL.

    Raise `ValueError` se non parsabile.
    """
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
    """Estrai chiamate dal `response` del modello provando più strategie.

    Returns:
        (calls, meta). `calls = None` se nessuna strategia funziona (oppure se
        il response è vuoto/esplicitamente "no call"). `meta["strategy"]` indica
        quale parser ha funzionato.
    """
    meta: dict[str, Any] = {"strategy": None}
    if not isinstance(response, str):
        return None, {"strategy": None, "reason": "non-string response"}
    txt = response.strip()
    if not txt:
        return None, {"strategy": None, "reason": "empty response"}

    # 1) <TOOLCALL>...</TOOLCALL> tag (formato BFCL ufficiale per molti modelli)
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

    # 2) Python code block ```python ... ``` con call(s)
    py_blocks = _CODE_BLOCK_PY_RE.findall(txt)
    for blk in reversed(py_blocks):  # ultimo blocco prima
        candidate = blk.strip()
        # rimuovi eventuali assegnamenti tipo "result = fn(...)"
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

    # 6) Solo l'ultima riga sembra una chiamata?
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

# Default model name per `convert_func_name` (con stub `underscore_to_dot=False`
# il valore non incide sul matching; usiamo un nome neutro). Espone l'env var
# per override esplicito se in futuro vorremo aderire a regole specifiche di
# uno dei tre modelli pool.
DEFAULT_MODEL_NAME = "brick-evals-generic"


def grade_bfcl(
    response: str,
    payload: dict[str, Any],
    model_name: str = DEFAULT_MODEL_NAME,
) -> tuple[bool | None, dict[str, Any]]:
    """Grading singolo per BFCL single-turn.

    Args:
        response: testo grezzo del modello target.
        payload: contenuto di `expected_answer.payload`. Chiavi attese:
            - `ground_truth_calls`: list di `{fn_name: {arg: [accepted_values]}}`
            - `function_specs`: list di JSON-schema funzioni disponibili
            - `category`: una di {simple, multiple, parallel, parallel_multiple, irrelevance}
            - `id`: identificatore BFCL (opzionale, per meta)
        model_name: chiave passata a `ast_checker` (ininfluente con lo stub).

    Returns:
        (correct, meta):
          - correct=True iff `ast_checker(...)["valid"]`
          - correct=False se parsing fallisce o checker rifiuta
          - correct=None se grader non disponibile / payload non valido
    """
    if not AVAILABLE:
        return None, {"reason": f"BFCL not available: {_IMPORT_ERR}"}

    category = (payload.get("category") or "").lower()
    bfcl_id = payload.get("id")
    if not category:
        return None, {"reason": "missing category in payload", "id": bfcl_id}

    func_description = payload.get("function_specs") or []
    ground_truth = payload.get("ground_truth_calls") or []

    decoded, parse_meta = extract_calls(response)

    # Caso irrelevance: il modello NON deve chiamare alcuna funzione.
    if category == "irrelevance":
        # Nessuna chiamata parsabile -> corretto. Qualunque chiamata -> errato.
        correct = decoded is None or len(decoded) == 0
        return correct, {
            "category": category,
            "id": bfcl_id,
            "parse": parse_meta,
            "decoded_n": 0 if decoded is None else len(decoded),
        }

    # Altri categorie: serve almeno una chiamata.
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
