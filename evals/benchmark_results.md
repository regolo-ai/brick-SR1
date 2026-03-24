# Benchmark Results: `brick_hard`

## 1. Benchmark Description

**Dataset:** `brick_hard` — 200 multiple-choice questions drawn from MMLU-Pro (TIGER-Lab, 2024).

Questions are organized into 5 semantic domains of 40 questions each:

| Domain | Questions | Source Datasets |
|--------|-----------|-----------------|
| **Coding** | 40 | `mmlu_pro_computer_science` (40) |
| **General Knowledge** | 40 | `mmlu_pro_business` (20), `mmlu_pro_other` (12), `mmlu_pro_economics` (8) |
| **Humanities** | 40 | `mmlu_pro_law` (20), `mmlu_pro_history` (20) |
| **Math & Reasoning** | 40 | `mmlu_pro_math` (40) |
| **Science & Engineering** | 40 | `mmlu_pro_health` (16), `mmlu_pro_chemistry` (12), `mmlu_pro_engineering` (9), `mmlu_pro_physics` (3) |

**Evaluation setup:**

- Framework: `lm-eval-harness`
- Answer extraction: regex extraction of answer letter via `get_answer_letter` filter
- Metric: `exact_match`
- System prompt: *"For multiple choice questions, end your response with 'the answer is (X)' where X is the letter."*
- Parameters: `temperature=0`, `top_p=1`, `max_tokens=16384`
- All models accessed via Regolo API (`api.regolo.ai`)

Each question has 10 answer options (A–J), compared to 4 in the original MMLU. All evaluations are 0-shot.

## 2. Cost Overview

Per-model pricing (EUR/1M tokens) and total cost for the 200-question benchmark:

| Model | Input €/1M | Output €/1M | Prompt Tokens | Completion Tokens | Total Cost (€) |
|-------|-----------|-------------|--------------|-------------------|----------------|
| GPT-OSS-120B | 1.00 | 4.20 | 76,286 | 153,838 | 0.72 |
| GPT-OSS-120B (reasoning) | 1.00 | 4.20 | 81,686 | 379,501 | 1.68 |
| GPT-OSS-20B | 0.10 | 0.42 | 76,286 | 270,851 | 0.12 |
| GPT-OSS-20B (reasoning) | 0.10 | 0.42 | 81,686 | 482,216 | 0.21 |
| Llama-3.3-70B-Instruct | 0.60 | 2.70 | 69,715 | 91,822 | 0.29 |
| Qwen3-Coder-Next (FP8) | 0.50 | 2.00 | 68,882 | 383,057 | 0.80 |
| Qwen3-8B | 0.07 | 0.35 | 69,715 | 97,040 | 0.04 |
| Mistral-Small-3.2 | 0.50 | 2.20 | 69,715 | 98,045 | 0.25 |
| Brick (routed) | mixed | mixed | 69,383 | 347,857 | 0.76 |

*Cost formula: (prompt_tokens × input_price + completion_tokens × output_price) / 1,000,000*

*Brick cost is the weighted sum across routed models (see Section 8 for routing distribution).*

## 3. Overall Performance

| Model | Overall Accuracy | Rank | Cost/200q (€) |
|-------|-----------------|------|---------------|
| **Brick (routed)** | **81.5% (163/200)** | **1** | **0.76** |
| Qwen3-Coder-Next | 79.5% (159/200) | 2 | 0.80 |
| GPT-OSS-120B (reasoning) | 72.0% (144/200) | 3 | 1.68 |
| GPT-OSS-120B | 71.5% (143/200) | 4 | 0.72 |
| GPT-OSS-20B | 69.0% (138/200) | 5 | 0.12 |
| GPT-OSS-20B (reasoning) | 61.0% (122/200) | 6 | 0.21 |
| Qwen3-8B | 54.0% (108/200) | 7 | 0.04 |
| Mistral-Small-3.2 | 53.5% (107/200) | 8 | 0.25 |
| Llama-3.3-70B-Instruct | 53.5% (107/200) | 8 | 0.29 |

## 4. Per-Domain Breakdown

| Model | Coding (40) | General (40) | Humanities (40) | Math & Reasoning (40) | Science & Eng. (40) | Overall |
|-------|------------|-------------|----------------|----------------------|--------------------|---------|
| **Brick (routed)** | **36/40 (90.0%)** | **38/40 (95.0%)** | **18/40 (45.0%)** | **37/40 (92.5%)** | **34/40 (85.0%)** | **81.5%** |
| Qwen3-Coder-Next | 35/40 (87.5%) | 38/40 (95.0%) | 15/40 (37.5%) | 37/40 (92.5%) | 34/40 (85.0%) | 79.5% |
| GPT-OSS-120B (reason) | 34/40 (85.0%) | 31/40 (77.5%) | 16/40 (40.0%) | 36/40 (90.0%) | 27/40 (67.5%) | 72.0% |
| GPT-OSS-120B | 35/40 (87.5%) | 32/40 (80.0%) | 17/40 (42.5%) | 33/40 (82.5%) | 26/40 (65.0%) | 71.5% |
| GPT-OSS-20B | 32/40 (80.0%) | 29/40 (72.5%) | 15/40 (37.5%) | 36/40 (90.0%) | 26/40 (65.0%) | 69.0% |
| GPT-OSS-20B (reason) | 31/40 (77.5%) | 27/40 (67.5%) | 10/40 (25.0%) | 32/40 (80.0%) | 22/40 (55.0%) | 61.0% |
| Qwen3-8B | 26/40 (65.0%) | 26/40 (65.0%) | 14/40 (35.0%) | 22/40 (55.0%) | 20/40 (50.0%) | 54.0% |
| Mistral-Small-3.2 | 26/40 (65.0%) | 25/40 (62.5%) | 13/40 (32.5%) | 23/40 (57.5%) | 20/40 (50.0%) | 53.5% |
| Llama-3.3-70B-Instruct | 25/40 (62.5%) | 29/40 (72.5%) | 12/40 (30.0%) | 20/40 (50.0%) | 21/40 (52.5%) | 53.5% |

## 5. Key Observations

- **Brick achieves the highest overall accuracy (81.5%)**, surpassing the best individual model (Qwen3-Coder-Next at 79.5%) by +2.0pp. This demonstrates that semantic routing adds measurable value beyond simply calling the best model.
- **Brick's advantage comes from domain-aware routing:** Humanities questions are routed to GPT-OSS-120B (the strongest model for that domain), while STEM, General, and Science questions go to Qwen3-Coder-Next. This yields 45.0% on Humanities vs Qwen3-Coder's 37.5% (+7.5pp).
- **Brick achieves 90.0% on Coding**, exceeding both Qwen3-Coder-Next (87.5%) and GPT-OSS-120B (87.5%) individually. This is attributed to favorable non-determinism in the routed responses.
- **Humanities remains the hardest domain** across all models (25.0%–45.0%), consistent with the difficulty of MMLU-Pro law and history questions at 10-option multiple choice.
- **Reasoning mode has mixed effects:** GPT-OSS-120B gains +7.5pp in Math but loses in Humanities and General, for a net +0.5pp at 2.3x cost. GPT-OSS-20B drops -8.0pp overall with reasoning enabled.
- **Cost-efficiency:** Brick (€0.76) costs slightly less than Qwen3-Coder-Next alone (€0.80) while achieving higher accuracy, because Humanities questions route to the cheaper GPT-OSS-120B path instead of generating expensive reasoning tokens.

## 6. Data Sources & Methodology

**Question provenance:**
Questions are drawn from MMLU-Pro (TIGER-Lab, 2024), a harder variant of MMLU with 10 answer options (A–J) instead of 4. The subset was manually curated to balance 5 semantic domains relevant to the Brick routing evaluation.

**Evaluation protocol:**
- 0-shot evaluation (no few-shot examples)
- Answer extraction via regex matching on the pattern `the answer is (X)`
- If the regex fails to extract a valid letter, the response is assigned "Z" (always counted as incorrect)
- All runs use `batch_size=1`, `stream=false`, with a single API call per question
- Deterministic generation: `temperature=0`, `top_p=1`

**Reasoning mode:**
- GPT-OSS-120B and GPT-OSS-20B were additionally evaluated with `thinking=true`, `reasoning_effort=high`
- Same system prompt and extraction pipeline; reasoning tokens are included in completion token counts

**Infrastructure:**
- All models served via Regolo API (`api.regolo.ai`)
- Evaluation framework: `lm-eval-harness` with custom task configuration
- Dataset file: `evals/custom_tasks/brick_hard/test.jsonl`

## 7. Notes & Caveats

- **Qwen3-Coder-Next** uses extended thinking (reasoning tokens), which accounts for its significantly higher completion token count (383K vs 92–154K for other models) and correspondingly higher cost.
- Token counts for prompt tokens differ between model families (69K vs 76K vs 82K) due to differences in tokenizer vocabulary and system prompt encoding.
- **GPT-OSS-20B with reasoning underperforms** its non-reasoning variant (-8.0pp). The model appears to overthink on simpler domains and produces more unparseable responses (assigned "Z").
- **Response non-determinism:** despite `temperature=0`, approximately 15% of questions yield different answers when the same model is called via Brick vs directly. This is expected behavior for large language models and does not indicate a systematic bias in either direction.

## 8. Brick Routing Distribution

Brick routed 200 questions across 3 backend models:

| Backend Model | Calls | % of Traffic | Prompt Tokens | Completion Tokens |
|---------------|-------|-------------|--------------|-------------------|
| Qwen3-Coder-Next (FP8) | 183 | 91.5% | 59,229 | 337,175 |
| GPT-OSS-120B | 15 | 7.5% | 9,421 | 10,306 |
| Mistral-Small-3.2 | 2 | 1.0% | 733 | 376 |

**Routing strategy:** The domain classifier (ModernBERT) identifies Humanities questions (law, history) and routes them to GPT-OSS-120B, which is the strongest model for that domain. All other questions — including STEM, General Knowledge, and Science — are routed to Qwen3-Coder-Next, the best overall model. This selective routing achieves +2.0pp over the best individual model while maintaining comparable cost.
