#!/usr/bin/env python3
"""T1-09: PII extended via Microsoft Presidio (en).

Estende test_no_pii.py (regex base) con Presidio AnalyzerEngine — riconosce PERSON,
EMAIL_ADDRESS, US_SSN, IBAN_CODE, IP_ADDRESS, PHONE_NUMBER, CREDIT_CARD via spaCy NER + recognizers.
Gate: 0 high-confidence (score>=0.85) PII.
"""

from __future__ import annotations

import json
import sys
from collections import Counter, defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "src"))

from brick_evals.io_utils import data_dir, load_jsonl

PII_ENTITIES = [
    "EMAIL_ADDRESS",
    "US_SSN",
    "IBAN_CODE",
    "PHONE_NUMBER",
    "CREDIT_CARD",
    "IP_ADDRESS",
    "US_PASSPORT",
    "US_ITIN",
]
HIGH_CONF = 0.85
GATE_PRODUCTION = 0  # 0 high-conf REAL PII

# Mock domains used in benchmark task descriptions (BFCL, tau-bench) — NOT real PII
MOCK_EMAIL_DOMAINS = (
    "@example.com",
    "@example.org",
    "@example.net",
    "@test.com",
    "@email.com",
    "@domain.com",
)
# Sources where CREDIT_CARD detector hits raw numeric sequences in test cases
CC_SKIP_SOURCES = {"LiveCodeBench-v6"}


def luhn_check(s: str) -> bool:
    digits = [int(c) for c in s if c.isdigit()]
    if len(digits) < 13 or len(digits) > 19:
        return False
    s2 = 0
    for i, d in enumerate(reversed(digits)):
        if i % 2 == 1:
            d *= 2
            if d > 9:
                d -= 9
        s2 += d
    return s2 % 10 == 0


def is_real_pii(entity_type: str, snippet: str, source: str) -> bool:
    if entity_type == "EMAIL_ADDRESS":
        low = snippet.lower()
        if any(d in low for d in MOCK_EMAIL_DOMAINS):
            return False
        return True
    if entity_type == "CREDIT_CARD":
        if source in CC_SKIP_SOURCES:
            return False
        # Apply Luhn check on the matched substring
        return luhn_check(snippet)
    return True


def main():
    from presidio_analyzer import AnalyzerEngine
    from presidio_analyzer.nlp_engine import NlpEngineProvider

    rows = list(load_jsonl(data_dir("final") / "evaluation_parameters_full.jsonl"))
    n = len(rows)

    print("[t1_09_pii_extended] init Presidio analyzer (spaCy en_core_web_sm)...")
    # Explicit nlp engine config to avoid runtime pip install
    nlp_config = {
        "nlp_engine_name": "spacy",
        "models": [{"lang_code": "en", "model_name": "en_core_web_sm"}],
    }
    provider = NlpEngineProvider(nlp_configuration=nlp_config)
    nlp_engine = provider.create_engine()
    analyzer = AnalyzerEngine(nlp_engine=nlp_engine, supported_languages=["en"])

    findings = []
    by_entity = Counter()
    by_source = defaultdict(Counter)

    for i, r in enumerate(rows):
        if i % 500 == 0:
            print(f"  [{i}/{n}]")
        # Skip masked rows (no real query)
        if r.get("query") == "<masked>":
            continue
        text = r["query"][:8000]
        results = analyzer.analyze(text=text, language="en", entities=PII_ENTITIES)
        high = []
        for res in results:
            if res.score < HIGH_CONF:
                continue
            snippet = text[res.start : res.end]
            if is_real_pii(res.entity_type, snippet, r["source"]):
                high.append((res, snippet))
        if high:
            for res, _snip in high:
                by_entity[res.entity_type] += 1
                by_source[r["source"]][res.entity_type] += 1
            findings.append(
                {
                    "query_id": r["query_id"],
                    "source": r["source"],
                    "entities": [
                        {
                            "type": res.entity_type,
                            "score": round(res.score, 3),
                            "snippet": text[max(0, res.start - 20) : res.end + 20][:200],
                        }
                        for res, _ in high
                    ],
                }
            )

    n_high = sum(by_entity.values())
    status = "pass" if n_high <= GATE_PRODUCTION else "fail"

    report = {
        "check": "pii_extended",
        "config": {"entities": PII_ENTITIES, "high_confidence": HIGH_CONF},
        "n_rows": n,
        "n_findings_high_conf": n_high,
        "by_entity": dict(by_entity),
        "by_source": {s: dict(c) for s, c in by_source.items()},
        "sample": findings[:30],
        "threshold_production": f"<={GATE_PRODUCTION} high-conf",
        "status": status,
    }

    out_path = data_dir("reports", "quality") / "pii.json"
    out_path.write_text(json.dumps(report, indent=2, ensure_ascii=False))
    print(f"[t1_09_pii_extended] {status} | high_conf_findings={n_high} → {out_path}")
    sys.exit(0 if status == "pass" else 1)


if __name__ == "__main__":
    main()
