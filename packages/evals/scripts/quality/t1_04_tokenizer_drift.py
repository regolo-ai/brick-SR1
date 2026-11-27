#!/usr/bin/env python3
"""T1-04: Tokenizer drift — re-tokenize all rows, compare with stored counts.

- Recompute mismatch (stored vs recompute) — gate <0.1%
- qwen↔ds, qwen↔kimi, ds↔kimi cross-tokenizer drift histogram (informational)
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "src"))

from brick_evals.io_utils import data_dir, load_jsonl
from brick_evals.tokenizers import count_tokens_batch

GATE_RECOMPUTE_MISMATCH = 0.001  # <0.1%


def main():
    rows = list(load_jsonl(data_dir("final") / "evaluation_parameters_full.jsonl"))
    n = len(rows)
    texts = [r["query"] for r in rows]

    print(f"[t1_04_tokenizer_drift] re-tokenizing {n} texts (qwen3.5-9b, deepseek-v4-flash, kimi2.6)...")
    qwen_recomp = count_tokens_batch(texts, "qwen3.5-9b", batch_size=64)
    ds_recomp = count_tokens_batch(texts, "deepseek-v4-flash", batch_size=64)
    kimi_recomp = count_tokens_batch(texts, "kimi2.6", batch_size=64)

    qwen_stored = [r["input_tokens_qwen"] for r in rows]
    ds_stored = [r["input_tokens_deepseek"] for r in rows]
    kimi_stored = [r["input_tokens_kimi"] for r in rows]

    def mismatch_count(stored, recomp):
        return sum(1 for s, r in zip(stored, recomp, strict=False) if s != r)

    mq = mismatch_count(qwen_stored, qwen_recomp)
    md = mismatch_count(ds_stored, ds_recomp)
    mk = mismatch_count(kimi_stored, kimi_recomp)

    # Cross-tokenizer drift (informational, baseline 33% rows >100 tok)
    drift_qwen_ds = [abs(q - d) for q, d in zip(qwen_recomp, ds_recomp, strict=False)]
    drift_qwen_kimi = [abs(q - k) for q, k in zip(qwen_recomp, kimi_recomp, strict=False)]
    drift_ds_kimi = [abs(d - k) for d, k in zip(ds_recomp, kimi_recomp, strict=False)]

    def stats(arr):
        if not arr:
            return {}
        s = sorted(arr)
        return {
            "min": s[0],
            "p50": s[len(s) // 2],
            "p90": s[int(len(s) * 0.9)],
            "p99": s[int(len(s) * 0.99)],
            "max": s[-1],
            "n_over_100": sum(1 for v in arr if v > 100),
            "ratio_over_100": round(sum(1 for v in arr if v > 100) / len(arr), 4),
        }

    max_recomp_mismatch = max(mq, md, mk) / n
    status = "pass" if max_recomp_mismatch < GATE_RECOMPUTE_MISMATCH else "fail"

    report = {
        "check": "tokenizer_drift",
        "n_rows": n,
        "recompute_mismatch": {
            "qwen": {"n": mq, "ratio": round(mq / n, 4)},
            "deepseek": {"n": md, "ratio": round(md / n, 4)},
            "kimi": {"n": mk, "ratio": round(mk / n, 4)},
        },
        "cross_tokenizer_drift_abs": {
            "qwen_vs_deepseek": stats(drift_qwen_ds),
            "qwen_vs_kimi": stats(drift_qwen_kimi),
            "deepseek_vs_kimi": stats(drift_ds_kimi),
        },
        "max_recompute_mismatch_ratio": round(max_recomp_mismatch, 4),
        "threshold_production": f"<{GATE_RECOMPUTE_MISMATCH:.1%}",
        "note": "Cross-tokenizer drift > 100 tok atteso (33% baseline) — proxy V3/K2.5 vs Qwen ufficiale ±2-5%, documentato in dataset_card",
        "status": status,
    }

    out_path = data_dir("reports", "quality") / "tokenizer_drift.json"
    out_path.write_text(json.dumps(report, indent=2, ensure_ascii=False))
    print(
        f"[t1_04_tokenizer_drift] {status} | mismatch qwen={mq} ds={md} kimi={mk} "
        f"(max ratio {max_recomp_mismatch:.4%}) → {out_path}"
    )
    sys.exit(0 if status == "pass" else 1)


if __name__ == "__main__":
    main()
