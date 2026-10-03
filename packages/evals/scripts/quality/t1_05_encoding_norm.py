#!/usr/bin/env python3
"""T1-05: Encoding/normalization — UTF-8 NFC, ftfy mojibake, control char scan.

Gate: 0 mojibake + 0 critical control chars.
"""

from __future__ import annotations

import json
import sys
import unicodedata
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "src"))

import ftfy
from brick_evals.io_utils import data_dir, load_jsonl

# Control chars not allowed (excluding \n \t \r — common in code/CoT)
DISALLOWED_CTRL = set(chr(c) for c in list(range(0, 9)) + [11, 12] + list(range(14, 32)) + [127])


def has_disallowed_ctrl(text: str) -> list[int]:
    return [i for i, c in enumerate(text) if c in DISALLOWED_CTRL]


def main():
    rows = list(load_jsonl(data_dir("final") / "evaluation_parameters_full.jsonl"))
    n = len(rows)

    mojibake = []
    nfc_diffs = []
    ctrl_hits = []

    for r in rows:
        q = r["query"]
        # Mojibake check via ftfy.is_bad (richiede *real* mojibake, non semplici quote/dash unicode)
        try:
            if ftfy.is_bad(q):
                fixed = ftfy.fix_text(q)
                mojibake.append(
                    {
                        "query_id": r["query_id"],
                        "source": r["source"],
                        "snippet_before": q[:200],
                        "snippet_after": fixed[:200],
                    }
                )
        except Exception:
            pass
        # NFC normalization diff
        nfc = unicodedata.normalize("NFC", q)
        if nfc != q:
            nfc_diffs.append({"query_id": r["query_id"], "source": r["source"]})
        # Control char
        positions = has_disallowed_ctrl(q)
        if positions:
            ctrl_hits.append({"query_id": r["query_id"], "source": r["source"], "n_ctrl": len(positions)})

    status = "pass" if not mojibake and not ctrl_hits else "fail"

    report = {
        "check": "encoding_norm",
        "n_rows": n,
        "n_mojibake": len(mojibake),
        "n_nfc_normalization_diff": len(nfc_diffs),
        "n_disallowed_ctrl_char": len(ctrl_hits),
        "mojibake_sample": mojibake[:20],
        "nfc_diff_sample": nfc_diffs[:20],
        "ctrl_sample": ctrl_hits[:20],
        "threshold_production": "0 mojibake + 0 ctrl",
        "note": "NFC diffs informativi (canonical equivalence non-breaking)",
        "status": status,
    }

    out_path = data_dir("reports", "quality") / "encoding.json"
    out_path.write_text(json.dumps(report, indent=2, ensure_ascii=False))
    print(
        f"[t1_05_encoding_norm] {status} | mojibake={len(mojibake)} ctrl={len(ctrl_hits)} "
        f"nfc_diff={len(nfc_diffs)} → {out_path}"
    )
    sys.exit(0 if status == "pass" else 1)


if __name__ == "__main__":
    main()
