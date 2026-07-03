#!/usr/bin/env python3
"""72 - Push HF Hub massaindustries/dataset-A-routing (evals/results/verbose).

3 config su dataset_A completo (5339 query, 3 modelli: qwen3.5-9b, deepseek-v4-flash, kimi2.6):
- evals   : prompt + ground_truth (no risposte modelli)
- results : query_id + qwen_correct/ds4_correct/kimi_correct (nullable bool)
- verbose : results + raw responses + costs/latency + 3x3 judge per planning + grader_meta

Usage:
    python3 scripts/72_push_dataset_a_routing.py --dry-run   # build + parquet locali, no push
    python3 scripts/72_push_dataset_a_routing.py             # build + push HF
"""

from __future__ import annotations

import argparse
import copy
import json
import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from brick_evals.io_utils import data_dir, hf_token, load_jsonl, repo_root

REPO_ID = "massaindustries/dataset-A-routing"

MODELS = ["qwen", "ds4", "kimi"]

REPO_ROOT = repo_root()

GRADED_FILES: dict[str, list[Path]] = {
    "qwen": [
        REPO_ROOT / "data/inference/qwen3.5-9b/planning_full_graded__panel.jsonl",
        REPO_ROOT / "data/inference/qwen3.5-9b/multi_turn_full_graded.jsonl",
        REPO_ROOT / "runs_individual/R1/qwen9b/outputs/qwen35_9b_full_graded_v2.jsonl",
        REPO_ROOT / "runs_individual/R1/qwen9b/outputs/qwen35_9b_llmjudge_graded.jsonl",
    ],
    "ds4": [
        REPO_ROOT / "data/inference/deepseek-v4-flash/planning_full_graded__panel.jsonl",
        REPO_ROOT / "data/inference/deepseek-v4-flash/multi_turn_full_graded.jsonl",
        REPO_ROOT / "data/inference/deepseek-v4-flash/dataset_a_deterministic_graded.jsonl",
        REPO_ROOT / "data/inference/deepseek-v4-flash/dataset_a_llmjudge_graded.jsonl",
    ],
    "kimi": [
        REPO_ROOT / "data/inference/kimi2.6/planning_full_graded__panel.jsonl",
        REPO_ROOT / "data/inference/kimi2.6/multi_turn_full_graded.jsonl",
        REPO_ROOT / "data/inference/kimi2.6/dataset_a_deterministic_graded.jsonl",
        REPO_ROOT / "data/inference/kimi2.6/dataset_a_llmjudge_graded.jsonl",
    ],
}

INDIVIDUAL_JUDGES: dict[str, dict[str, Path]] = {
    "qwen": {
        "gpt54mini": REPO_ROOT / "data/inference/qwen3.5-9b/planning_full_graded.jsonl",
        "mistral": REPO_ROOT / "data/inference/qwen3.5-9b/planning_full_graded__mistral.jsonl",
        "glm": REPO_ROOT / "data/inference/qwen3.5-9b/planning_full_graded__glm.jsonl",
    },
    "ds4": {
        "gpt54mini": REPO_ROOT / "data/inference/deepseek-v4-flash/planning_full_graded.jsonl",
        "mistral": REPO_ROOT / "data/inference/deepseek-v4-flash/planning_full_graded__mistral.jsonl",
        "glm": REPO_ROOT / "data/inference/deepseek-v4-flash/planning_full_graded__glm.jsonl",
    },
    "kimi": {
        "gpt54mini": REPO_ROOT / "data/inference/kimi2.6/planning_full_graded.jsonl",
        "mistral": REPO_ROOT / "data/inference/kimi2.6/planning_full_graded__mistral.jsonl",
        "glm": REPO_ROOT / "data/inference/kimi2.6/planning_full_graded__glm.jsonl",
    },
}

MODEL_ID_REAL = {
    "qwen": "Qwen/Qwen3.5-9B",
    "ds4": "deepseek/deepseek-v4-flash",
    "kimi": "moonshotai/Kimi-K2.6",
}


def mask_gated_rows(rows: list[dict]) -> list[dict]:
    out = []
    for r in rows:
        if r.get("gated"):
            r2 = copy.deepcopy(r)
            r2["query"] = "<masked>"
            ea = r2["expected_answer"]
            ea["payload"] = "<masked>"
            ea["type"] = "masked"
            r2["few_shot_examples"] = []
            out.append(r2)
        else:
            out.append(r)
    return out


def serialize_evals(rows: list[dict]) -> list[dict]:
    out = []
    for r in rows:
        r2 = dict(r)
        r2["expected_answer"] = json.dumps(r["expected_answer"], ensure_ascii=False)
        r2["few_shot_examples"] = json.dumps(r.get("few_shot_examples", []), ensure_ascii=False)
        out.append(r2)
    return out


def load_model_index(model: str) -> dict[str, dict]:
    """Carica record graded per `model`, indicizzati per query_id. Verifica no duplicati."""
    index: dict[str, dict] = {}
    for path in GRADED_FILES[model]:
        if not path.exists():
            raise FileNotFoundError(f"[{model}] missing: {path}")
        n_dup = 0
        for rec in load_jsonl(path):
            qid = rec.get("query_id")
            if qid in index:
                n_dup += 1
            index[qid] = rec
        if n_dup:
            print(f"  WARN [{model}] {path.name}: {n_dup} query_id duplicate, kept last")
    return index


def load_individual_judges(model: str) -> dict[str, dict[str, bool]]:
    """Carica i 3 judge singoli per planning_agentic single-turn. Restituisce {qid: {judge: correct}}."""
    out: dict[str, dict[str, bool]] = {}
    for judge_name, path in INDIVIDUAL_JUDGES[model].items():
        if not path.exists():
            print(f"  WARN [{model}] missing individual judge: {path}")
            continue
        for rec in load_jsonl(path):
            qid = rec.get("query_id")
            if qid not in out:
                out[qid] = {}
            out[qid][judge_name] = rec.get("correct")
    return out


def collect_multiturn_rows(model_idx: dict[str, dict[str, dict]]) -> list[dict]:
    """Estrae le righe multi_turn (query_id che iniziano con `multi_turn_`) presenti in tutti i 3 modelli.
    Non sono nel base dataset_A; dimension reassigned a `planning_agentic_multiturn`."""
    mt_qids = set()
    for m in MODELS:
        for qid, _rec in model_idx[m].items():
            if isinstance(qid, str) and qid.startswith("multi_turn_"):
                mt_qids.add(qid)
    out = []
    for qid in sorted(mt_qids):
        sample = None
        for m in MODELS:
            if qid in model_idx[m]:
                sample = model_idx[m][qid]
                break
        gm = sample.get("grader_meta", {}) if sample else {}
        category = gm.get("category", "") if isinstance(gm, dict) else ""
        out.append(
            {
                "query_id": qid,
                "query": "<multi-turn-benchmark>",
                "dimension": "planning_agentic_multiturn",
                "evaluation_protocol_id": sample.get("evaluation_protocol_id", "tool_call_match")
                if sample
                else "tool_call_match",
                "source": f"BFCL-multi-turn-{category}" if category else "BFCL-multi-turn",
                "gated": False,
                "expected_answer": {"type": "multi_turn", "payload": "<see grader_meta per turn>"},
                "few_shot_examples": [],
                "shots": 0,
                "input_tokens_qwen": None,
                "input_tokens_deepseek": None,
                "input_tokens_kimi": None,
                "license": "Apache-2.0",
                "length_band": "med",
            }
        )
    return out


def build_evals_df(base_rows: list[dict], extra_rows: list[dict]):
    import pandas as pd

    all_rows = base_rows + extra_rows
    masked = mask_gated_rows(all_rows)
    serialized = serialize_evals(masked)
    return pd.DataFrame(serialized)


def build_results_df(base_rows: list[dict], extra_rows: list[dict], model_idx: dict[str, dict[str, dict]]):
    import pandas as pd

    DIM_ORDER = {
        "planning_agentic": 0,
        "planning_agentic_multiturn": 1,
        "math_reasoning": 2,
        "coding": 3,
        "instruction_following": 4,
        "world_knowledge": 5,
        "creative_synthesis": 6,
    }
    sorted_rows = sorted(base_rows + extra_rows, key=lambda r: (DIM_ORDER.get(r["dimension"], 99), r["query_id"]))

    rows_out = []
    for r in sorted_rows:
        qid = r["query_id"]
        is_gated = bool(r.get("gated"))
        row = {
            "query_id": qid,
            "query": "<masked>" if is_gated else r["query"],
            "dimension": r["dimension"],
            "evaluation_protocol_id": r["evaluation_protocol_id"],
            "source": r.get("source"),
            "gated": is_gated,
        }
        for m in MODELS:
            mrec = model_idx[m].get(qid)
            row[f"{m}_correct"] = mrec.get("correct") if mrec else None
        rows_out.append(row)
    return pd.DataFrame(rows_out)


def build_verbose_df(
    base_rows: list[dict],
    extra_rows: list[dict],
    model_idx: dict[str, dict[str, dict]],
    individual_judges: dict[str, dict[str, dict[str, bool]]],
):
    import pandas as pd

    # Ordina con planning_agentic (single-turn, judge individuali popolati) per primo
    # così datasets.load_dataset inferisce correttamente il tipo bool delle colonne *_judge_*.
    DIM_ORDER = {
        "planning_agentic": 0,
        "planning_agentic_multiturn": 1,
        "math_reasoning": 2,
        "coding": 3,
        "instruction_following": 4,
        "world_knowledge": 5,
        "creative_synthesis": 6,
    }
    sorted_rows = sorted(base_rows + extra_rows, key=lambda r: (DIM_ORDER.get(r["dimension"], 99), r["query_id"]))

    rows_out = []
    for r in sorted_rows:
        qid = r["query_id"]
        is_gated = bool(r.get("gated"))
        row = {
            "query_id": qid,
            "query": "<masked>" if is_gated else r["query"],
            "dimension": r["dimension"],
            "evaluation_protocol_id": r["evaluation_protocol_id"],
            "source": r.get("source"),
            "gated": is_gated,
        }
        for m in MODELS:
            mrec = model_idx[m].get(qid) or {}
            row[f"{m}_correct"] = mrec.get("correct")
            row[f"{m}_response"] = mrec.get("model_raw_response", "")
            row[f"{m}_thinking"] = mrec.get("model_raw_thinking_output", "")
            row[f"{m}_cost_usd"] = mrec.get("cost")
            row[f"{m}_latency_ms"] = mrec.get("latency_ms")
            row[f"{m}_completion_tokens"] = mrec.get("completion_tokens")
            row[f"{m}_reasoning_tokens"] = mrec.get("reasoning_tokens")
            row[f"{m}_input_tokens"] = mrec.get("input_tokens")
            row[f"{m}_finish_reason"] = mrec.get("finish_reason")
            row[f"{m}_grader_meta"] = (
                json.dumps(mrec.get("grader_meta"), ensure_ascii=False) if mrec.get("grader_meta") is not None else None
            )
            row[f"{m}_model_id_real"] = mrec.get("model_id_real")

            jverdicts = individual_judges[m].get(qid, {})
            row[f"{m}_judge_gpt54mini"] = jverdicts.get("gpt54mini")
            row[f"{m}_judge_mistral"] = jverdicts.get("mistral")
            row[f"{m}_judge_glm"] = jverdicts.get("glm")
        rows_out.append(row)
    return pd.DataFrame(rows_out)


def _write_parquet(df, path: Path, row_group_size: int = 500) -> None:
    """Write df as parquet in chunks via ParquetWriter per evitare ArrowCapacityError
    (limite int32 byte-length per array contiguo). Ogni chunk diventa un row_group separato."""
    import pyarrow as pa
    import pyarrow.parquet as pq

    chunk_size = max(row_group_size, 50)
    schema = pa.Table.from_pandas(df.iloc[:1], preserve_index=False).schema
    writer = pq.ParquetWriter(str(path), schema, compression="zstd")
    try:
        for start in range(0, len(df), chunk_size):
            chunk = df.iloc[start : start + chunk_size]
            table = pa.Table.from_pandas(chunk, schema=schema, preserve_index=False)
            writer.write_table(table, row_group_size=chunk_size)
    finally:
        writer.close()


def _write_jsonl_from_df(df, path: Path) -> None:
    """Salva DataFrame come JSONL.gz (1 riga = 1 obj). Usato per evals con expected_answer
    enormi (LiveCodeBench private_tests fino a ~90MB) che non entrano in Parquet."""
    import gzip

    import pandas as pd

    path.parent.mkdir(parents=True, exist_ok=True)

    def _clean(v):
        # Normalizza pandas NA / numpy nan / Boolean NA → None per JSON
        if v is pd.NA:
            return None
        if isinstance(v, float) and v != v:
            return None
        try:
            if pd.isna(v):
                return None
        except (TypeError, ValueError):
            pass
        return v

    with gzip.open(str(path), "wt", encoding="utf-8") as f:
        for _, row in df.iterrows():
            obj = {k: _clean(v) for k, v in row.items()}
            f.write(json.dumps(obj, ensure_ascii=False, separators=(",", ":"), default=str) + "\n")


def _coerce_nullable_bools(df, cols: list[str]):
    """Cast colonne con bool/None mix a pandas BooleanDtype (pyarrow lo mappa a nullable bool)."""
    for c in cols:
        if c not in df.columns:
            continue
        df[c] = df[c].astype("boolean")
    return df


def _prepend_schema_anchor(df):
    """Inserisce riga 0 con tutti i campi popolati (no null). Forza schema-inference di
    datasets a tipi concreti invece di null type. Utenti devono filtrare query_id != '_schema_anchor'."""
    import pandas as pd

    anchor = {}
    for col in df.columns:
        nn = df[col].dropna()
        if len(nn) == 0:
            anchor[col] = "_anchor_"
            continue
        v = nn.iloc[0]
        if isinstance(v, bool) or str(df[col].dtype) == "boolean":
            anchor[col] = True
        elif isinstance(v, int):
            anchor[col] = 0
        elif isinstance(v, float):
            anchor[col] = 0.0
        else:
            anchor[col] = "_anchor_"
    anchor["query_id"] = "_schema_anchor"
    anchor_df = pd.DataFrame([anchor])
    # Allinea dtype delle colonne bool nullable
    for col in df.columns:
        if str(df[col].dtype) == "boolean":
            anchor_df[col] = anchor_df[col].astype("boolean")
    return pd.concat([anchor_df, df], ignore_index=True)


def make_readme(stats: dict) -> str:
    n = stats["total"]
    by_dim = stats["by_dim"]
    n_gated = stats["n_gated"]
    coverage = stats["coverage"]
    win_rate = stats["win_rate"]
    abst = stats["abstention"]

    lines = []
    lines.append("---")
    lines.append("license: cc-by-4.0")
    lines.append("language:")
    lines.append("  - en")
    lines.append("tags:")
    lines.append("  - routing")
    lines.append("  - evaluation")
    lines.append("  - llm-router")
    lines.append("  - multi-domain")
    lines.append("  - model-comparison")
    lines.append("size_categories:")
    lines.append("  - 1K<n<10K")
    lines.append("configs:")
    lines.append("  - config_name: results")
    lines.append("    default: true")
    lines.append("    data_files:")
    lines.append("      - split: train")
    lines.append("        path: data/results/train.jsonl.gz")
    lines.append("  - config_name: verbose")
    lines.append("    data_files:")
    lines.append("      - split: train")
    lines.append("        path: data/verbose/train.jsonl.gz")
    lines.append("  - config_name: evals")
    lines.append("    data_files:")
    lines.append("      - split: train")
    lines.append("        path: data/evals/train.jsonl.gz")
    lines.append("---")
    lines.append("")
    lines.append("# Dataset A - Routing (3 modelli, verdict-level)")
    lines.append("")
    lines.append(f"**Totale query:** {n} | **Gated (masked) query:** {n_gated}")
    lines.append("")
    lines.append(
        "Dataset di valutazione per LLM routing systems su 6 capability. Ogni query è stata eseguita su 3 modelli (qwen3.5-9b, deepseek-v4-flash, kimi2.6) e giudicata con grader deterministici (math/coding/ifeval) o LLM judge panel 2-of-3 (planning_agentic) / single judge (creative_synthesis, world_knowledge)."
    )
    lines.append("")
    lines.append("## Configs")
    lines.append("")
    lines.append("```python")
    lines.append("from datasets import load_dataset")
    lines.append("")
    lines.append("# Pivot verdict per query (default config, 3 colonne bool)")
    lines.append(f'ds_results = load_dataset("{REPO_ID}", split="train")')
    lines.append("")
    lines.append("# Full: raw responses, costs, latency, 3x3 judge per planning, grader_meta")
    lines.append(f'ds_verbose = load_dataset("{REPO_ID}", name="verbose", split="train")')
    lines.append("")
    lines.append("# Prompts + ground truth (no model outputs): per replicare i test")
    lines.append(f'ds_evals = load_dataset("{REPO_ID}", name="evals", split="train")')
    lines.append("")
    lines.append("# Tutti i config hanno una riga `_schema_anchor` (query_id == '_schema_anchor') con valori")
    lines.append("# dummy per fissare lo schema di datasets/PyArrow. Filtrala via:")
    lines.append('#   ds = ds.filter(lambda r: r["query_id"] != "_schema_anchor")')
    lines.append("```")
    lines.append("")
    lines.append("## Schema `results`")
    lines.append("")
    lines.append("| campo | tipo | note |")
    lines.append("|---|---|---|")
    lines.append("| `query_id` | string | `q_NNNNN` |")
    lines.append("| `query` | string | `<masked>` se gated |")
    lines.append("| `dimension` | string | 1 di 6 capability |")
    lines.append("| `evaluation_protocol_id` | string | protocollo grader |")
    lines.append("| `source` | string | dataset originale |")
    lines.append("| `gated` | bool | dataset proprietary (query mascherata) |")
    lines.append("| `qwen_correct` | bool/null | verdict primario qwen3.5-9b |")
    lines.append("| `ds4_correct` | bool/null | verdict primario deepseek-v4-flash |")
    lines.append("| `kimi_correct` | bool/null | verdict primario kimi2.6 |")
    lines.append("")
    lines.append("`*_correct` è `null` quando il judge ha astensione (~1.4% del totale).")
    lines.append("")
    lines.append("## Schema `verbose`")
    lines.append("")
    lines.append("Tutti i campi di `results` + per ogni modello m in {qwen, ds4, kimi}:")
    lines.append("- `{m}_response` (string, raw output)")
    lines.append("- `{m}_thinking` (string, raw thinking chain)")
    lines.append("- `{m}_cost_usd` (float, null per qwen)")
    lines.append("- `{m}_latency_ms` (int)")
    lines.append("- `{m}_completion_tokens` (int)")
    lines.append("- `{m}_reasoning_tokens` (int)")
    lines.append("- `{m}_input_tokens` (int)")
    lines.append("- `{m}_finish_reason` (string)")
    lines.append("- `{m}_grader_meta` (string, JSON serializzato)")
    lines.append("- `{m}_model_id_real` (string)")
    lines.append("- `{m}_judge_gpt54mini` (bool/null, solo planning ST)")
    lines.append("- `{m}_judge_mistral` (bool/null, solo planning ST)")
    lines.append("- `{m}_judge_glm` (bool/null, solo planning ST)")
    lines.append("")
    lines.append("## Verdict source per dimension")
    lines.append("")
    lines.append("| dimension | rows | verdict source |")
    lines.append("|---|---|---|")
    lines.append(
        f"| planning_agentic | {by_dim.get('planning_agentic', 0)} | panel 2-of-3 (gpt-5.4-mini + mistral-small-2603 + glm-5-turbo) per ST; single judge per MT |"
    )
    lines.append(
        f"| math_reasoning | {by_dim.get('math_reasoning', 0)} | deterministic (math_equiv, gsm8k_final_answer) |"
    )
    lines.append(f"| coding | {by_dim.get('coding', 0)} | deterministic (unit_test_pass) |")
    lines.append(
        f"| instruction_following | {by_dim.get('instruction_following', 0)} | deterministic (ifeval_constraint_check) |"
    )
    lines.append(
        f"| world_knowledge | {by_dim.get('world_knowledge', 0)} | mix (deterministic mcq_letter per 102; LLM judge `llm_judge_factual` per 700) |"
    )
    lines.append(
        f"| creative_synthesis | {by_dim.get('creative_synthesis', 0)} | LLM judge `rubric_judge` (gpt-5.4-mini) |"
    )
    lines.append("")
    lines.append("## Win-rate per modello")
    lines.append("")
    lines.append("| modello | correct | incorrect | abstention | accuracy |")
    lines.append("|---|---|---|---|---|")
    for m in MODELS:
        wr = win_rate[m]
        ab = abst[m]
        denom = wr["true"] + wr["false"]
        acc = wr["true"] / denom if denom else 0.0
        lines.append(f"| {m} | {wr['true']} | {wr['false']} | {ab} | {acc:.4f} |")
    lines.append("")
    lines.append("## Coverage check")
    lines.append("")
    lines.append("Ogni modello ha verdict per tutte le 5339 query:")
    lines.append("")
    lines.append("| modello | query con verdict | coverage |")
    lines.append("|---|---|---|")
    for m in MODELS:
        c = coverage[m]
        lines.append(f"| {m} | {c} | {c / n * 100:.1f}% |")
    lines.append("")
    lines.append("## Reproducibility")
    lines.append("")
    lines.append(
        "- Stesso pool di 5339 query del dataset base [`massaindustries/dataset-A-routing-eval`](https://huggingface.co/datasets/massaindustries/dataset-A-routing-eval)"
    )
    lines.append("- Inference deterministic (temperature=0.0)")
    lines.append("- Judge panel costanti, prompt template versionati nello skill `llmevals`")
    lines.append("- Per ripetere i test: scarica config `evals`, esegui inference, applica grader")
    lines.append("")
    lines.append("## License")
    lines.append("")
    lines.append(
        "CC-BY-4.0 (eccetto query originali dei dataset gated, che restano sotto le license dei rispettivi source)."
    )
    lines.append("")
    lines.append("## Citation")
    lines.append("")
    lines.append(
        "Per i source originali del dataset_A, vedere `lockfile.yaml` in [`massaindustries/dataset-A-routing-eval`](https://huggingface.co/datasets/massaindustries/dataset-A-routing-eval)."
    )
    return "\n".join(lines)


def compute_stats(all_rows, model_idx, results_df) -> dict:
    n = len(all_rows)
    by_dim = Counter(r["dimension"] for r in all_rows)
    n_gated = sum(1 for r in all_rows if r.get("gated"))
    coverage = {m: sum(1 for r in all_rows if r["query_id"] in model_idx[m]) for m in MODELS}
    win_rate = {}
    abstention = {}
    for m in MODELS:
        col = results_df[f"{m}_correct"]
        win_rate[m] = {
            "true": int((col == True).sum()),  # noqa: E712
            "false": int((col == False).sum()),  # noqa: E712
        }
        abstention[m] = int(col.isna().sum())
    return {
        "total": n,
        "by_dim": dict(by_dim),
        "n_gated": n_gated,
        "coverage": coverage,
        "win_rate": win_rate,
        "abstention": abstention,
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true", help="solo build locale, no push HF")
    args = parser.parse_args()

    print("=== build dataset_A_routing ===")
    base_path = data_dir("final") / "evaluation_parameters_full.jsonl"
    base_rows = list(load_jsonl(base_path))
    print(f"loaded base dataset: {len(base_rows)} rows from {base_path}")

    print("\nloading model indexes...")
    model_idx: dict[str, dict[str, dict]] = {}
    for m in MODELS:
        idx = load_model_index(m)
        model_idx[m] = idx
        print(f"  {m}: {len(idx)} unique query_id")

    print("\nloading individual judges for planning ST...")
    individual_judges: dict[str, dict[str, dict[str, bool]]] = {}
    for m in MODELS:
        ij = load_individual_judges(m)
        individual_judges[m] = ij
        print(f"  {m}: {len(ij)} query_id with individual judge verdicts")

    print("\ncollecting multi-turn extra rows (not in base dataset)...")
    extra_rows = collect_multiturn_rows(model_idx)
    print(f"  multi-turn rows: {len(extra_rows)}")

    print("\nbuilding DataFrames...")
    evals_df = build_evals_df(base_rows, extra_rows)
    evals_df = _prepend_schema_anchor(evals_df)
    print(f"  evals_df: {len(evals_df)} rows, {len(evals_df.columns)} cols (incl. schema anchor)")
    results_df = build_results_df(base_rows, extra_rows, model_idx)
    bool_cols_results = [f"{m}_correct" for m in MODELS]
    results_df = _coerce_nullable_bools(results_df, bool_cols_results)
    results_df = _prepend_schema_anchor(results_df)
    print(f"  results_df: {len(results_df)} rows, {len(results_df.columns)} cols (incl. schema anchor)")
    verbose_df = build_verbose_df(base_rows, extra_rows, model_idx, individual_judges)
    bool_cols_verbose = bool_cols_results + [f"{m}_judge_{j}" for m in MODELS for j in ("gpt54mini", "mistral", "glm")]
    verbose_df = _coerce_nullable_bools(verbose_df, bool_cols_verbose)
    verbose_df = _prepend_schema_anchor(verbose_df)
    print(f"  verbose_df: {len(verbose_df)} rows, {len(verbose_df.columns)} cols (incl. schema anchor)")

    stats = compute_stats(base_rows + extra_rows, model_idx, results_df)
    print("\nstats:")
    print(f"  by_dim: {stats['by_dim']}")
    print(f"  coverage: {stats['coverage']}")
    print(f"  win_rate: {stats['win_rate']}")
    print(f"  abstention: {stats['abstention']}")
    print(f"  n_gated: {stats['n_gated']}")

    out_dir = data_dir("final") / "dataset_A_routing"
    out_dir.mkdir(parents=True, exist_ok=True)
    for cfg in ("evals", "results", "verbose"):
        (out_dir / cfg).mkdir(parents=True, exist_ok=True)

    print(f"\nwriting data files to {out_dir}...")
    # Uniform JSONL.gz per i 3 config:
    # - evals: LiveCodeBench private_tests fino a ~90MB single row, sfora Parquet int32 → JSONL obbligatorio
    # - results+verbose: stesso formato per evitare bug datasets 4.7 mixed-config (jsonl+parquet)
    # - schema-inference verbose ok perché build_verbose_df ordina planning_agentic per primo
    _write_jsonl_from_df(evals_df, out_dir / "evals" / "train.jsonl.gz")
    print(f"  evals.jsonl.gz: {(out_dir / 'evals' / 'train.jsonl.gz').stat().st_size / 1e6:.2f} MB")
    _write_jsonl_from_df(results_df, out_dir / "results" / "train.jsonl.gz")
    print(f"  results.jsonl.gz: {(out_dir / 'results' / 'train.jsonl.gz').stat().st_size / 1e6:.2f} MB")
    _write_jsonl_from_df(verbose_df, out_dir / "verbose" / "train.jsonl.gz")
    print(f"  verbose.jsonl.gz: {(out_dir / 'verbose' / 'train.jsonl.gz').stat().st_size / 1e6:.2f} MB")

    # Cleanup parquet locali eventualmente presenti da run precedenti
    for cfg in ("evals", "results", "verbose"):
        stale = out_dir / cfg / "train.parquet"
        if stale.exists():
            stale.unlink()

    readme = make_readme(stats)
    readme_path = out_dir / "README.md"
    readme_path.write_text(readme, encoding="utf-8")
    print(f"  README.md ({len(readme)} chars)")

    stats_path = out_dir / "build_stats.json"
    stats_path.write_text(json.dumps(stats, indent=2), encoding="utf-8")
    print("  build_stats.json")

    if args.dry_run:
        print(f"\n[DRY-RUN] skipping HF push. Files saved to {out_dir}")
        return

    print(f"\n=== push to HF Hub: {REPO_ID} ===")
    from huggingface_hub import HfApi, login

    login(token=hf_token())
    api = HfApi(token=hf_token())
    api.create_repo(repo_id=REPO_ID, repo_type="dataset", private=False, exist_ok=True)

    cfg_files = {
        "evals": "train.jsonl.gz",
        "results": "train.jsonl.gz",
        "verbose": "train.jsonl.gz",
    }
    for cfg, fname in cfg_files.items():
        local = out_dir / cfg / fname
        remote = f"data/{cfg}/{fname}"
        print(f"  uploading {local} → {remote}")
        api.upload_file(
            path_or_fileobj=str(local),
            path_in_repo=remote,
            repo_id=REPO_ID,
            repo_type="dataset",
            commit_message=f"dataset_A_routing config={cfg}",
        )

    print("  uploading README.md")
    api.upload_file(
        path_or_fileobj=str(readme_path),
        path_in_repo="README.md",
        repo_id=REPO_ID,
        repo_type="dataset",
        commit_message="dataset card with multi-config + verdict stats",
    )

    print("  uploading build_stats.json")
    api.upload_file(
        path_or_fileobj=str(stats_path),
        path_in_repo="build_stats.json",
        repo_id=REPO_ID,
        repo_type="dataset",
        commit_message="build stats snapshot",
    )

    print(f"\nDONE. Visit: https://huggingface.co/datasets/{REPO_ID}")


if __name__ == "__main__":
    main()
