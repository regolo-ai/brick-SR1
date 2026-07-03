#!/usr/bin/env python3
"""99 - Unmask gated (GAIA + GPQA): per chi ha access, ri-popola query mascherate.

Prerequisiti:
- Account HF con access accepted a `gaia-benchmark/GAIA` e `Idavidrein/gpqa`
- HF token configurato

Input: data/final/evaluation_parameters_full.jsonl (locale, contiene gia' query non-masked).
Se manca, ricostruisce dal masked variant + ri-download.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from brick_evals.io_utils import data_dir, load_jsonl


def main():
    full_path = data_dir("final") / "evaluation_parameters_full.jsonl"

    if full_path.exists():
        print(f"[OK] full variant esiste localmente: {full_path}")
        rows = list(load_jsonl(full_path))
        gated = [r for r in rows if r["gated"]]
        masked = [r for r in gated if r["query"] == "<masked>"]
        if not masked:
            print(f"[OK] tutte le {len(gated)} righe gated sono già unmasked.")
            return 0

    print("[INFO] full variant non disponibile o ha mascheramento residuo.")
    print("       Ri-esegui pipeline 10/20/40/50 (per gated source) per popolare full localmente.")
    print("       In particolare:")
    print("         python scripts/10_download.py gaia")
    print("         python scripts/10_download.py gpqa_diamond")
    print("         python scripts/20_normalize.py gaia")
    print("         python scripts/20_normalize.py gpqa_diamond")
    print("         python scripts/40_assemble_eval_params.py")
    print("         python scripts/50_tokenize_triplo.py")
    print("       Output finale: data/final/evaluation_parameters_full.jsonl (privato, NON pushato).")


if __name__ == "__main__":
    main()
