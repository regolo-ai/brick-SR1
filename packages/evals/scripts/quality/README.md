# Quality Validation Suite (Dataset A rev.4)

3-tier quality validation per `massaindustries/dataset-A-routing-eval`.

## Quick start

```bash
# Tier 1 deterministic (~15 min, no API cost)
python3 scripts/quality/run_all.py

# Tier 1 + Tier 2 LLM-as-judge (~3h, ~$25 Regolo)
python3 scripts/quality/run_all.py --judge

# Full incl. Tier 3 manual review (after 2 reviewer compilano CSV)
python3 scripts/quality/t3_01_sample_review.py     # genera CSV
# ... reviewer 1+2 compilano data/reports/quality/sample_review.csv ...
python3 scripts/quality/run_all.py --judge --kappa
```

## Tier 1 — Deterministic (no API)

| Script | Check | Gate |
|---|---|---|
| t1_01_schema_rev3 | 14-col schema rev.3 + validate_row | 100% pass |
| t1_02_dedup_minhash | MinHash+LSH cross/intra source | cross<2%, intra<20% |
| t1_03_dedup_embed | sentence-transformers all-mpnet-base-v2 cosine ≥0.92 | cross<1%, intra<20% |
| t1_04_tokenizer_drift | Re-tokenize qwen/deepseek/kimi vs stored | <0.1% mismatch |
| t1_05_encoding_norm | UTF-8 NFC, ftfy mojibake, ctrl chars | 0 mojibake + 0 ctrl |
| t1_06_payload_typed | jsonschema Draft 2020-12 per `expected_answer.type` | 100% pass |
| t1_07_distribution | length×dim, shots×dim, license, Chi² | sanity_failures=0 |
| t1_08_contamination_ngram | 13-gram cross-source overlap LMSYS-style | <5% per source |
| t1_09_pii_extended | Presidio EN: EMAIL/SSN/IBAN/CC/PHONE/IP (mock @example.com filtered) | 0 real PII |
| t1_10_toxicity_offline | Detoxify CPU + threshold 0.7 | <0.1% flagged |
| t1_11_irt_proxy | Proxy difficulty manifest (no inference yet) | informational |
| t1_12_hub_roundtrip | `load_dataset` HF Hub + 50-row sample inspect | schema match + 0 issues |
| t1_13_manifest_sha | SHA256 manifest + HF revision pin | files present + revision known |

## Tier 2 — LLM-as-judge (Regolo qwen3.5-122b)

| Script | Check | Sample | Cost | Gate |
|---|---|---|---|---|
| t2_01_fewshot_coherence | Rubric 5-axes × 3 judges majority vote | 600 rows | ~$8 | avg≥4.0/5 per source |
| t2_02_answer_sanity | Judge solves & compares with expected_answer | 400 rows | ~$4 | <8% disagreement |
| t2_03_capability_tag | Judge predicts dimension (Bloom-style) | 540 rows | ~$5 | ≥92% agreement |
| t2_04_routing_signal_proxy | Judge predicts {A,B,C}_success pattern | 540 rows | ~$8 | unanimous<25% |

## Tier 3 — Manual review (2 reviewers)

| Script | Check |
|---|---|
| t3_01_sample_review | Stratified 1% CSV (~54 rows) per dimension×source×length_band |
| t3_02_kappa_calc | Cohen's kappa ≥0.7 + error_rate <3% |

## Helper modules (`src/scientificv1/`)

- `judge.py` — RegoloClient wrapper, rubric scoring, majority vote, position swap
- `dedup.py` — MinHash, FAISS embedding, `extract_actual_query` (strip few-shot prefix)
- `contamination.py` — n-gram overlap, canary GUID

## Output

- `data/reports/quality/*.json` — per-check structured reports
- `data/reports/quality/*.jsonl` — per-row judge results (Tier 2)
- `data/reports/quality/sample_review.csv` — 2-reviewer manual review
- `data/reports/quality/FINAL_REPORT.md` — aggregate, gating overall PASS/FAIL

## Tests

```bash
PYTHONPATH=src python3 -m pytest tests/quality/ -q
```
