#!/usr/bin/env python3
"""Quality validation orchestrator.

Esegue Tier 1 (sempre), Tier 2 (con --judge), Tier 3 kappa (con --kappa, dopo che 2 reviewer hanno compilato CSV).
Aggrega risultati in FINAL_REPORT.md con production-ready gating.

Usage:
    python3 scripts/quality/run_all.py [--judge] [--kappa] [--skip <step>] [--only <step>]
"""

from __future__ import annotations

import argparse
import json
import subprocess
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPTS_DIR = REPO_ROOT / "scripts" / "quality"
REPORTS_DIR = REPO_ROOT / "data" / "reports" / "quality"
ENV = {"PYTHONPATH": str(REPO_ROOT / "src")}

T1 = [
    ("t1_01_schema_rev3", "schema.json"),
    ("t1_02_dedup_minhash", "dedup_minhash.json"),
    ("t1_03_dedup_embed", "dedup_embed.json"),
    ("t1_04_tokenizer_drift", "tokenizer_drift.json"),
    ("t1_05_encoding_norm", "encoding.json"),
    ("t1_06_payload_typed", "payload.json"),
    ("t1_07_distribution", "distribution.json"),
    ("t1_08_contamination_ngram", "contamination.json"),
    ("t1_09_pii_extended", "pii.json"),
    ("t1_10_toxicity_offline", "toxicity.json"),
    ("t1_11_irt_proxy", "irt_proxy.json"),
    ("t1_12_hub_roundtrip", "hub_roundtrip.json"),
    ("t1_13_manifest_sha", "manifest.json"),
    ("t1_14_language_check", "language.json"),
    ("t1_15_query_nonempty", "query_nonempty.json"),
]
T2 = [
    ("t2_01_fewshot_coherence", "fewshot_coherence_summary.json"),
    ("t2_02_answer_sanity", "answer_sanity_summary.json"),
    ("t2_03_capability_tag", "capability_tag_summary.json"),
    ("t2_04_routing_signal_proxy", "routing_signal_summary.json"),
]
T3 = [
    ("t3_02_kappa_calc", "kappa.json"),
]


def run_step(script_name: str) -> int:
    print(f"\n{'=' * 60}\n>>> {script_name}\n{'=' * 60}")
    import os

    env = os.environ.copy()
    env.update(ENV)
    rc = subprocess.run(
        ["python3", str(SCRIPTS_DIR / f"{script_name}.py")],
        env=env,
        cwd=REPO_ROOT,
    ).returncode
    print(f"<<< {script_name} exit={rc}")
    return rc


def collect_status(report_file: Path) -> dict:
    if not report_file.exists():
        return {"status": "missing", "report_path": str(report_file)}
    try:
        return json.loads(report_file.read_text())
    except Exception as e:
        return {"status": "unparseable", "error": str(e)[:120]}


def render_report(t1_results: dict, t2_results: dict, t3_results: dict) -> str:
    lines = ["# Dataset A — Quality Validation Report", ""]
    lines.append("Repo: `massaindustries/dataset-A-routing-eval`")
    lines.append("")

    overall_status = "PASS"

    def section(title: str, results: dict):
        nonlocal overall_status
        lines.append(f"## {title}")
        lines.append("")
        lines.append("| check | status | notes |")
        lines.append("|---|---|---|")
        for name, payload in results.items():
            st = payload.get("status", "missing")
            if st != "pass":
                overall_status = "FAIL"
            note = ""
            n = name
            if n == "schema_rev3":
                note = f"rows={payload.get('n_rows')} errs={payload.get('n_errors')}"
            elif n == "dedup_minhash":
                cs = payload.get("cross_source", {})
                intra = payload.get("intra_source", {})
                note = (
                    f"cross={cs.get('n_pairs')} ({cs.get('ratio')}) intra={intra.get('n_pairs')} ({intra.get('ratio')})"
                )
            elif n == "dedup_embed":
                cs = payload.get("cross_source", {})
                intra = payload.get("intra_source", {})
                note = f"cross={cs.get('n_pairs')} intra={intra.get('n_pairs')}"
            elif n == "tokenizer_drift":
                m = payload.get("recompute_mismatch", {})
                note = f"mismatch q={m.get('qwen', {}).get('n')} d={m.get('deepseek', {}).get('n')} k={m.get('kimi', {}).get('n')}"
            elif n == "encoding_norm":
                note = f"mojibake={payload.get('n_mojibake')} ctrl={payload.get('n_disallowed_ctrl_char')}"
            elif n == "payload_typed":
                note = f"errors={payload.get('n_errors')}/{payload.get('n_rows')}"
            elif n == "distribution":
                note = f"sanity_failures={len(payload.get('sanity_failures', []))}"
            elif n == "contamination_ngram":
                note = f"failed_sources={payload.get('failed_sources')}"
            elif n == "pii_extended":
                note = f"high_conf={payload.get('n_findings_high_conf')}"
            elif n == "toxicity_offline":
                note = f"flagged={payload.get('n_flagged')} ({payload.get('ratio')})"
            elif n == "irt_proxy":
                note = f"manifest entries={payload.get('n_rows')}"
            elif n == "hub_roundtrip":
                note = f"hub={payload.get('n_hub')} local={payload.get('n_local')}"
            elif n == "manifest_sha":
                note = f"hf_rev={(payload.get('hf') or {}).get('revision_sha', '?')[:12]}"
            elif n == "language_check":
                note = f"non_english={payload.get('n_flagged')}"
            elif n == "query_nonempty":
                note = f"empty_queries={payload.get('n_flagged')}"
            elif n == "fewshot_coherence":
                note = f"failed_sources={payload.get('failed_sources')}"
            elif n == "answer_sanity":
                note = f"disagreement={payload.get('disagreement_ratio')}"
            elif n == "capability_tag":
                note = f"agreement={payload.get('agreement')}"
            elif n == "routing_signal_proxy":
                note = f"unanimous={payload.get('ratio_unanimous')}"
            elif n == "manual_review_kappa":
                note = f"kappa={payload.get('kappa')} error_rate={payload.get('error_rate')}"
            lines.append(f"| `{name}` | **{st.upper()}** | {note} |")
        lines.append("")

    section("Tier 1 — Deterministic", t1_results)
    if t2_results:
        section("Tier 2 — LLM-as-judge", t2_results)
    if t3_results:
        section("Tier 3 — Manual review", t3_results)

    lines.append(f"## Overall: **{overall_status}**")
    lines.append("")
    lines.append("Production-ready gating: ALL checks must PASS.")
    lines.append("")
    # Notes for known by-design behaviors
    lines.append("### Note interpretive")
    lines.append("")
    lines.append(
        "- **dedup intra-source** alti per EQ-Bench-Creative-v3 (96 rows = 32 prompt × 3 iter, by-design EQ-Bench v3 protocol). PII/CC false positives su LiveCodeBench filtrati (numeri test_cases) e su BFCL/tau-bench (`@example.com` mock domain)."
    )
    lines.append(
        "- **answer_sanity** disagreement riflette difficoltà del benchmark + judge intra-pool family (`qwen3.5-122b` vs `qwen3.5-9b`); è un proxy preliminare, vera valutazione richiede inference Phase 2 sui 3 modelli reali."
    )
    lines.append(
        "- **capability_tag** confusion `instruction_following ↔ creative_synthesis` riflette confine ambiguo del task (creative writing è anche following constraint stilistici)."
    )
    lines.append(
        "- **routing_signal_proxy** vero dato dopo Phase 2 inference. Output qui è prediction qualitative del judge."
    )
    return "\n".join(lines)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--judge", action="store_true", help="Run Tier 2 (Regolo costo ~$25)")
    parser.add_argument("--kappa", action="store_true", help="Compute Cohen's kappa (after 2-reviewer CSV ready)")
    parser.add_argument("--skip", action="append", default=[], help="Skip step by name (repeatable)")
    parser.add_argument("--only", action="append", default=[], help="Run only these steps")
    parser.add_argument("--no-stop", action="store_true", help="Continue on failure")
    args = parser.parse_args()

    REPORTS_DIR.mkdir(parents=True, exist_ok=True)

    def run_phase(steps):
        for name, _ in steps:
            if name in args.skip:
                print(f"[skip] {name}")
                continue
            if args.only and name not in args.only:
                continue
            rc = run_step(name)
            if rc != 0 and not args.no_stop:
                print(f"[run_all] step {name} failed (rc={rc}); use --no-stop to continue anyway")

    run_phase(T1)
    if args.judge:
        run_phase(T2)
    if args.kappa:
        run_phase(T3)

    # Aggregate
    t1_results = {n: collect_status(REPORTS_DIR / f) for n, f in T1}
    t1_results = {
        payload.get("check", n): payload for n, payload in zip([n for n, _ in T1], t1_results.values(), strict=False)
    }
    t2_results = {}
    if args.judge:
        t2_collected = {n: collect_status(REPORTS_DIR / f) for n, f in T2}
        t2_results = {
            payload.get("check", n): payload
            for n, payload in zip([n for n, _ in T2], t2_collected.values(), strict=False)
        }
    t3_results = {}
    if args.kappa:
        t3_collected = {n: collect_status(REPORTS_DIR / f) for n, f in T3}
        t3_results = {
            payload.get("check", n): payload
            for n, payload in zip([n for n, _ in T3], t3_collected.values(), strict=False)
        }

    md = render_report(t1_results, t2_results, t3_results)
    out = REPORTS_DIR / "FINAL_REPORT.md"
    out.write_text(md)
    print(f"\n[run_all] Final report → {out}")
    print(md.split("Overall:")[-1].strip())


if __name__ == "__main__":
    main()
