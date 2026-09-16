# `packages/evals/`: Dataset A evaluation pipeline

End-to-end pipeline to grade an LLM (or the Brick router) on the 5,504-query
Dataset A and produce the per-dimension accuracy + cost numbers from the paper.

## What's in here

```text
packages/evals/
├── scripts/                    # Numbered pipeline (run in order)
│   ├── 00_setup_check.py            # validate env (HF token, API keys, tooling)
│   ├── 10_download.py               # bootstrap pulled benchmark sources (MMLU-Pro, BFCL, …)
│   ├── 10b_download_bfcl.py
│   ├── 10c_clone_bfcl_multi_turn.py
│   ├── 10c_download_livecodebench.py
│   ├── 11_clone_taubench.py
│   ├── 12_fetch_eqbench.py
│   ├── 13_planning_custom_generate.py
│   ├── 14_planning_custom_validate.py
│   ├── 20_normalize.py              # canonical schema (uses brick_evals.normalize.NORMALIZERS)
│   ├── 30_fewshot_extract.py        # few-shot pool extraction
│   ├── 30b_fewshot_regolo_generate.py
│   ├── 30c_fewshot_quality_regen.py
│   ├── 30d_fewshot_ifeval_realpool.py
│   ├── 31_creative_custom_generate.py
│   ├── 32_creative_custom_validate.py
│   ├── 40_assemble_eval_params.py   # merge per-query inference parameters
│   ├── 50_tokenize_triplo.py        # tokenize for 3 backend tokenizers
│   ├── 60_stratify_report.py        # stratification audit per dimension
│   ├── 70_push_hub.py               # push to massaindustries/dataset-A-routing-eval (legacy)
│   ├── 71_push_hub_multiconfig.py
│   ├── 72_push_dataset_a_routing.py # push to regolo/brick-dataset-A-routing-eval (canonical)
│   ├── 72_validate_routing_db.py
│   ├── 80_verify_dataset.py
│   ├── 99_unmask_gated.py
│   ├── 100_run_inference.py         # run inference for one model OR Brick router
│   ├── 110_grade_inference.py       # per-grader scoring (LCB, BFCL, IFEval, math-equiv, …)
│   ├── 115_aggregate_panel.py       # 3-judge majority vote
│   ├── 120_run_bfcl_multi_turn.py
│   ├── 130_aggregate_results.py     # final accuracy / cost / latency table
│   ├── 131_panel_report.py
│   └── 140_extract_model_skill_profiles.py
├── src/brick_evals/            # Python package (importable: `from brick_evals import ...`)
│   ├── regolo_client.py, openrouter_client.py
│   ├── judge.py + openrouter_judge_client.py
│   ├── graders/                # bfcl_grader, ifeval_grader, lcb_grader, rubric_judge_grader, simpleqa_grader
│   ├── normalize/              # NORMALIZERS registry per benchmark source
│   ├── tokenizers.py, schema.py, dedup.py, contamination.py, fewshot.py, io_utils.py
│   └── __init__.py
├── configs/
│   ├── models.yaml             # pool definition (qwen3.5-9b, deepseek-v4-flash, kimi2.6, ...)
│   ├── protocols.yaml          # per-dimension grader assignment
│   ├── prompts.yaml            # system / user templates
│   ├── sources.yaml            # benchmark provenance + version pins
│   └── judges.yaml             # 3-judge panel (gpt-5.4-mini + Mistral + GLM)
├── tests/                      # pytest (smoke + grader unit + schema + κ + PII)
├── baselines/                  # RouteLLM / FrugalGPT / cascade-routing → see baselines/README.md
└── pyproject.toml              # name = brick-evals
```

## Running the pipeline

Install the locked workspace with `uv sync --frozen --all-packages` and fetch
pinned BFCL source with `python3 scripts/bootstrap_eval_sources.py`.
The [evaluation quickstart](../../docs/quickstart/eval.md) gives executable
inference, grading and panel-aggregation examples using the actual script flags.

Stages 00–99 build and validate the evaluation inputs; 100–120 execute and grade
model requests. `130_aggregate_results.py` and `131_panel_report.py` read their
configured historical run layout. They do not accept arbitrary `--in` files.
Use `115_aggregate_panel.py --inputs ... --output ...` for explicit graded inputs.
Review the input layout before regenerating a historical report. Hub publication
stages are explicit remote writes and are never run by installation or CI.

## The 3-judge panel

Used for `rubric_judge` (planning + creative_synthesis) and `llm_judge_factual`
(world_knowledge subset). Configured in `configs/judges.yaml`:

| Judge | Model | Role |
|---|---|---|
| Judge 1 | `openai/gpt-5.4-mini` (via OpenRouter) | tie-breaker reference |
| Judge 2 | `mistralai/mistral-small-2603` | semantic precision |
| Judge 3 | `zai/glm-5-turbo` | factual recall |

Aggregation: 2-of-3 majority vote on a 4-point rubric
(`fail`/`partial`/`pass`/`exceptional`), with structured output parser per judge
to handle variant phrasings. See `src/brick_evals/judge.py` and
`src/brick_evals/graders/rubric_judge_grader.py`.

Historical paper measurements are reported in `docs/paper/paper.tex`; new
runs depend on the configured dataset revisions, model endpoints and prices.

## Per-dimension graders

| Dimension | Grader | Method |
|---|---|---|
| `coding` | `lcb_grader` | Unit-test execution (LiveCodeBench harness) |
| `math_reasoning` | `110_grade_inference.grade_math_equiv` | Symbolic equivalence (sympy + final-answer extractor) |
| `instruction_following` | `ifeval_grader` | Constraint-satisfaction checks (IFEval) |
| `planning_agentic` | `rubric_judge_grader` | 3-judge panel on rubric (planning quality) |
| `creative_synthesis` | `rubric_judge_grader` | 3-judge panel on rubric (creative quality) |
| `world_knowledge` | `simpleqa_grader` | LLM-judge factuality check |
| `planning_agentic` (function calls) | `bfcl_grader` | Function-calling correctness (BFCL) |

## Running tests

```bash
uv run --frozen pytest packages/evals/tests -q
# or just the smoke suite:
uv run --frozen pytest packages/evals/tests/test_smoke_load.py -q
```

## Test scope

`make test-python` runs required offline tests. Missing BFCL source or grader
dependencies fail collection. The `generated_data` tests require output from
the evaluation and quality pipelines, including external datasets and Hub
access. Run `make test-python-data` after producing those artifacts; missing
reports fail that check. Ordinary CI does not claim this dataset verification.
