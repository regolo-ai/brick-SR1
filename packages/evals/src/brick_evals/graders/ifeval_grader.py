"""IFEval grader wrapper sopra Google instruction_following_eval + IFBench (Allen AI).

Il dataset finale mescola due famiglie di constraint check:
- IFEval classico (google-research/instruction_following_eval): es. "change_case:english_capital",
  "length_constraints:number_words".
- IFBench (allenai/IFBench): es. "count:keywords_multiple", "count:conjunctions",
  "words:keywords_specific_position".

Il grader carica entrambi i registry e li unisce (IFBench ha precedenza in caso di
conflitto, perchA il set A8 piA9 recente).
"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Any

# Path al clone se non installato via pip
_EXT = Path(__file__).resolve().parents[3] / "external"
if _EXT.exists():
    _ext_str = str(_EXT)
    if _ext_str not in sys.path:
        sys.path.insert(0, _ext_str)

_REGISTRY: dict[str, Any] = {}

try:
    from instruction_following_eval import instructions_registry as _ifeval_reg  # type: ignore

    _REGISTRY.update(_ifeval_reg.INSTRUCTION_DICT)
    _IFEVAL_OK = True
except Exception:  # noqa: BLE001
    _IFEVAL_OK = False

try:
    from ifbench import instructions_registry as _ifbench_reg  # type: ignore

    _REGISTRY.update(_ifbench_reg.INSTRUCTION_DICT)
    _IFBENCH_OK = True
except Exception:  # noqa: BLE001
    _IFBENCH_OK = False

AVAILABLE = bool(_REGISTRY)


def grade_ifeval(
    response: str,
    instruction_id_list: list[str],
    kwargs_list: list[dict[str, Any]] | None,
) -> tuple[bool | None, dict[str, Any]]:
    """Restituisce (correct, meta).

    correct = True iff TUTTI gli instruction check passano.
    Errori per singolo check -> ok=False con error field. Se nessun check valido
    o lib mancante -> None.
    """
    if not AVAILABLE:
        return None, {"reason": "no instruction registry available (ifeval+ifbench missing)"}
    if not instruction_id_list:
        return None, {"reason": "empty instruction_id_list"}

    kwargs_list = kwargs_list or []
    per_check: list[dict[str, Any]] = []

    for idx, inst_id in enumerate(instruction_id_list):
        kwargs = kwargs_list[idx] if idx < len(kwargs_list) else {}
        kwargs = kwargs or {}
        # IFBench mette tutti i kwargs in un unico dict con i non usati a None.
        # Le classi non li accettano tutti -> filtra i None.
        kwargs = {k: v for k, v in kwargs.items() if v is not None}
        try:
            cls = _REGISTRY.get(inst_id)
            if cls is None:
                per_check.append({"id": inst_id, "ok": False, "error": "unknown instruction"})
                continue
            inst = cls(inst_id)
            inst.build_description(**kwargs)
            try:
                inst.get_instruction_args()
            except Exception:
                pass
            ok = bool(inst.check_following(response))
            per_check.append({"id": inst_id, "ok": ok})
        except Exception as e:  # noqa: BLE001
            per_check.append({"id": inst_id, "ok": False, "error": str(e)[:200]})

    all_ok = all(c["ok"] for c in per_check)
    return all_ok, {"per_check": per_check}
