# Benchmark Results: `brick_mixed`

## 1. Benchmark Description

**Dataset:** `brick_mixed` — 200 multiple-choice questions, mixing easy (4-choice) and hard (10-choice) difficulty.

Questions are organized into 5 semantic domains × 40 questions each, with a 50/50 easy/hard split:

| Domain | Total | Easy (4-choice) | Hard (10-choice) |
|--------|-------|-----------------|------------------|
| **Coding** | 40 | 20 (MMLU-Pro CS, normalized) | 20 (MMLU-Pro CS, raw 10-opt) |
| **Math & Reasoning** | 40 | 20 (MMLU-Pro math/eng, normalized) | 20 (MMLU-Pro math, raw 10-opt) |
| **Humanities** | 40 | 20 (MMLU-Pro law/history, normalized) | 20 (MMLU-Pro law/history, raw 10-opt) |
| **Science & Engineering** | 40 | 20 (MMLU-Pro bio/chem/physics/health, normalized) | 20 (MMLU-Pro health/chem/eng/physics, raw 10-opt) |
| **General Knowledge** | 40 | 20 (MMLU-Pro other/business/econ, normalized) | 20 (MMLU-Pro business/other/econ, raw 10-opt) |

**Easy questions** come from `brick_general` (4 choices A-D, answer normalized from 10-option MMLU-Pro by keeping the correct option + 3 random distractors, re-shuffled). **Hard questions** come from `brick_hard` (10 choices A-J, original MMLU-Pro format). 5 duplicate questions present in both source datasets were excluded from the easy pool before sampling.

**Evaluation setup:**

- Framework: `lm-eval-harness`
- Answer extraction: regex extraction of answer letter via `get_answer_letter` filter
- Metric: `exact_match`
- System prompt: *"For multiple choice questions, end your response with 'the answer is (X)' where X is the letter."*
- Parameters: `temperature=0`, `top_p=1`, `max_tokens=16384`
- All models accessed via Regolo API (`api.regolo.ai`)
- Regex accepts A-J (superset of A-D, covers both difficulty levels)

All evaluations are 0-shot. No reasoning mode variants were run for this benchmark.

## 2. Cost Overview

Per-model pricing (EUR/1M tokens) and total cost for the 200-question benchmark:

| Model | Input €/1M | Output €/1M | Prompt Tokens | Completion Tokens | Total Cost (€) |
|-------|-----------|-------------|--------------|-------------------|----------------|
| GPT-OSS-120B | 1.00 | 4.20 | 58,548 | 109,598 | 0.52 |
| GPT-OSS-20B | 0.10 | 0.42 | 58,548 | 286,592 | 0.13 |
| Llama-3.3-70B-Instruct | 0.60 | 2.70 | 51,926 | 80,335 | 0.25 |
| Qwen3-Coder-Next (FP8) | 0.50 | 2.00 | 49,709 | 285,382 | 0.60 |
| Qwen3-8B | 0.07 | 0.35 | 51,926 | 78,517 | 0.03 |
| Mistral-Small-3.2 | 0.50 | 2.20 | 51,926 | 79,225 | 0.25 |
| Brick (routed) | mixed | mixed | 50,635 | 267,883 | 0.59 |

*Cost formula: (prompt_tokens × input_price + completion_tokens × output_price) / 1,000,000*

*Brick cost is the weighted sum across routed models (see Section 7 for routing distribution).*

## 3. Overall Performance

| Model | Overall Accuracy | Rank | Cost/200q (€) |
|-------|-----------------|------|---------------|
| **Brick (routed)** | **85.0% (170/200)** | **1 (tie)** | **0.59** |
| **Qwen3-Coder-Next (FP8)** | **85.0% (170/200)** | **1 (tie)** | **0.60** |
| GPT-OSS-120B | 81.0% (162/200) | 3 | 0.52 |
| GPT-OSS-20B | 79.0% (158/200) | 4 | 0.13 |
| Llama-3.3-70B-Instruct | 69.0% (138/200) | 5 | 0.25 |
| Mistral-Small-3.2 | 69.0% (138/200) | 5 | 0.25 |
| Qwen3-8B | 68.5% (137/200) | 7 | 0.03 |

## 4. Per-Difficulty Breakdown

| Model | Easy (100) | Hard (100) | Overall (200) |
|-------|-----------|-----------|--------------|
| **Brick (routed)** | **88/100 (88.0%)** | **82/100 (82.0%)** | **170/200 (85.0%)** |
| Qwen3-Coder-Next (FP8) | 90/100 (90.0%) | 80/100 (80.0%) | 170/200 (85.0%) |
| GPT-OSS-120B | 86/100 (86.0%) | 76/100 (76.0%) | 162/200 (81.0%) |
| GPT-OSS-20B | 83/100 (83.0%) | 75/100 (75.0%) | 158/200 (79.0%) |
| Llama-3.3-70B-Instruct | 81/100 (81.0%) | 57/100 (57.0%) | 138/200 (69.0%) |
| Mistral-Small-3.2 | 81/100 (81.0%) | 57/100 (57.0%) | 138/200 (69.0%) |
| Qwen3-8B | 82/100 (82.0%) | 55/100 (55.0%) | 137/200 (68.5%) |

**Difficulty gap** (Easy − Hard accuracy):

| Model | Easy−Hard Gap |
|-------|--------------|
| Brick (routed) | +6.0pp |
| Qwen3-Coder-Next (FP8) | +10.0pp |
| GPT-OSS-120B | +10.0pp |
| GPT-OSS-20B | +8.0pp |
| Llama-3.3-70B-Instruct | +24.0pp |
| Mistral-Small-3.2 | +24.0pp |
| Qwen3-8B | +27.0pp |

## 5. Per-Domain Breakdown

| Model | Coding (40) | Math & Reasoning (40) | Humanities (40) | Science & Eng (40) | General (40) | Overall |
|-------|------------|----------------------|----------------|-------------------|-------------|---------|
| **Brick (routed)** | **35/40 (87.5%)** | **36/40 (90.0%)** | **25/40 (62.5%)** | **37/40 (92.5%)** | **37/40 (92.5%)** | **85.0%** |
| Qwen3-Coder-Next | 34/40 (85.0%) | 37/40 (92.5%) | 29/40 (72.5%) | 36/40 (90.0%) | 34/40 (85.0%) | 85.0% |
| GPT-OSS-120B | 35/40 (87.5%) | 32/40 (80.0%) | 25/40 (62.5%) | 35/40 (87.5%) | 35/40 (87.5%) | 81.0% |
| GPT-OSS-20B | 31/40 (77.5%) | 33/40 (82.5%) | 22/40 (55.0%) | 35/40 (87.5%) | 37/40 (92.5%) | 79.0% |
| Llama-3.3-70B-Instruct | 29/40 (72.5%) | 25/40 (62.5%) | 22/40 (55.0%) | 31/40 (77.5%) | 31/40 (77.5%) | 69.0% |
| Mistral-Small-3.2 | 31/40 (77.5%) | 25/40 (62.5%) | 22/40 (55.0%) | 31/40 (77.5%) | 29/40 (72.5%) | 69.0% |
| Qwen3-8B | 31/40 (77.5%) | 25/40 (62.5%) | 22/40 (55.0%) | 29/40 (72.5%) | 30/40 (75.0%) | 68.5% |

## 6. Key Observations

- **Brick matches the best model (85.0% = 85.0%)** at equal or lower cost (€0.59 vs €0.60 for Qwen3-Coder-Next). On a mixed-difficulty workload, routing achieves parity with the strongest individual model.
- **Brick has the smallest easy/hard accuracy gap (+6pp)** vs +10pp for Qwen3-Coder-Next. Brick routes ~50% of Humanities to GPT-OSS-120B (which is stronger on hard law/history questions), while Qwen3-Coder-Next handles easy Humanities more reliably (+10pp in Humanities overall). The trade-off is beneficial: Brick outperforms Qwen3-Coder on hard questions (+2pp, 82% vs 80%) while slightly underperforming on easy (+2pp in favor of Qwen3-Coder, 88% vs 90%).
- **Brick wins in Coding, Science, and General** vs Qwen3-Coder-Next (+2.5pp, +2.5pp, +7.5pp) but loses Humanities (−10pp) due to the GPT-OSS-120B humanities routing strategy, which was optimized for all-hard workloads.
- **Cost structure of the current config**: 87.5% of Brick traffic goes to Qwen3-Coder-Next (the expensive thinking model). The router does not differentiate by difficulty level in this configuration, resulting in near-identical cost to running Qwen3-Coder-Next directly.
- **Theoretical cost-saving potential**: If easy questions were routed to Qwen3-8B (€0.03/200q at 82% easy accuracy) and hard questions to Qwen3-Coder-Next (80% hard accuracy), the combined accuracy would be ~81% at ~€0.31/200q — a 2× cost reduction with −4pp accuracy. This "difficulty-aware" configuration is achievable with the current routing infrastructure by calibrating the complexity threshold.
- **Difficulty sensitivity**: Smaller models (Qwen3-8B, Llama, Mistral) show a 24-27pp easy/hard accuracy gap, confirming that difficulty is a strong signal for cost-optimized routing. GPT-OSS-120B shows a 10pp gap, and Brick only 6pp — the narrowest gap across all models.

## 7. Brick Routing Distribution

Brick routed 200 questions across 4 backend models:

| Backend Model | Calls | % of Traffic | Prompt Tokens | Completion Tokens | Cost (€) |
|---------------|-------|-------------|--------------|-------------------|---------|
| Qwen3-Coder-Next (FP8) | 175 | 87.5% | 39,516 | 255,315 | 0.5304 |
| GPT-OSS-120B | 21 | 10.5% | 9,572 | 11,634 | 0.0584 |
| Mistral-Small-3.2 | 2 | 1.0% | 890 | 308 | 0.0011 |
| Llama-3.3-70B-Instruct | 2 | 1.0% | 657 | 626 | 0.0021 |

**Routing by category:**

| Category | Qwen3-Coder-Next | GPT-OSS-120B | Other |
|----------|-----------------|-------------|-------|
| Coding | 38/40 (95%) | 1/40 (2%) | 1/40 |
| Math & Reasoning | 40/40 (100%) | 0 | 0 |
| Humanities | 18/40 (45%) | 20/40 (50%) | 2/40 |
| Science & Engineering | 40/40 (100%) | 0 | 0 |
| General Knowledge | 39/40 (98%) | 0 | 1/40 |

**Routing by difficulty:**

| Difficulty | Qwen3-Coder-Next | GPT-OSS-120B | Other | Total Cost (€) |
|-----------|-----------------|-------------|-------|---------------|
| Easy (100q) | 86 (86%) | 11 (11%) | 3 (3%) | 0.1660 |
| Hard (100q) | 89 (89%) | 10 (10%) | 1 (1%) | 0.4261 |

The router does not distinguish easy from hard questions in the current configuration: the routing split is nearly identical between difficulty levels. Humanities questions receive GPT-OSS-120B routing due to the domain classifier (ModernBERT), independent of difficulty.

## 8. Data Sources & Methodology

**Question provenance:**
- **Easy questions (4-choice)**: Drawn from `brick_general/test.jsonl`. Originally sampled from MMLU-Pro (normalized to 4 choices) and ARC-Challenge. The correct answer + 3 randomly selected distractors are re-shuffled.
- **Hard questions (10-choice)**: Drawn from `brick_hard/test.jsonl`. Original MMLU-Pro format with 10 answer options (A-J).
- **Deduplication**: 5 questions appearing in both source datasets (matched on first 100 characters of question text) were excluded from the easy pool.
- **Sampling**: `random.seed(42)`, 20 easy + 20 hard per category, then shuffled.

**Evaluation protocol:**
- 0-shot evaluation, `temperature=0`, `top_p=1`, `max_tokens=16384`
- Answer extraction: regex on `the answer is (X)`, fallback to "Z" (incorrect)
- `batch_size=1`, `stream=false`

## 9. Notes & Caveats

- **GPT-OSS-20B** shows significantly higher completion tokens (286K) vs GPT-OSS-120B (110K) despite lower accuracy, suggesting verbose or poorly structured output for some queries.
- **Qwen3-Coder-Next** uses extended thinking (reasoning tokens), explaining its high completion token count (285K) and correspondingly higher accuracy on hard questions.
- **Brick's Humanities regression**: The humanities routing to GPT-OSS-120B was calibrated on `brick_hard` (all 10-choice questions). In `brick_mixed`, easy humanities questions (4-choice) are better handled by Qwen3-Coder-Next, making the 50% humanities split to GPT-OSS-120B suboptimal. This results in Brick scoring 62.5% on Humanities vs 72.5% for Qwen3-Coder-Next standalone, despite identical overall scores.
- **Response non-determinism**: As in `brick_hard`, approximately 10-15% of questions produce different answers through Brick vs the same model directly, due to JSON re-serialization and token boundary non-determinism.
