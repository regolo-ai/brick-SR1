# Brick public skill tables

Per-model **skill vectors** consumed by the Brick router. Each `<model>.json` maps a
model id to a 6-dimensional capability vector in `[0,1]`. `brick init` reads this
folder to seed `skill_router.models[].skill_vector` for known model ids, so a user
never has to re-run inference for a model someone already measured.

This folder ships with the CLI (`templates/` is published) and mirrors the Hugging
Face dataset **`regolo/brick-skill-tables`**, which grows as users contribute
measurements for new models (`brick skills extract --publish`, opt-in).

## Capability order (canonical, never reorder)

```
[coding, creative_synthesis, instruction_following, math_reasoning, planning_agentic, world_knowledge]
```

## Record schema

```jsonc
{
  "model": "claude-haiku-4-5",
  "provider": "anthropic",
  "capabilities": ["coding", "...", "world_knowledge"],
  "skill_vector": [0.73, 0.65, 0.70, 0.81, 0.50, 0.77],
  "source": "benchmark",          // benchmark | measured | heuristic
  "confidence": ["medium", "low", "medium", "high", "medium", "medium"],
  "imputed_capabilities": [],     // coords filled from the model mean (NA in public benchmarks)
  "support": null,                // {correct,total} per capability — only for source=measured
  "subset_hash": null,            // frozen probe-set hash — only for source=measured
  "date": "2026-06-11",
  "notes": "..."
}
```

## `source` and trust order

1. **`measured`** — produced by `brick skills extract` running the frozen probe set
   against the model and grading verifiable categories (math exact-match, code
   tests, MMLU-Pro letter). Highest trust; carries `support` and `subset_hash`.
2. **`benchmark`** — derived from published AI-lab benchmarks (SWE-bench, AIME,
   GPQA, MMLU-Pro, tau-bench, …) normalized to `[0,1]`. Cold-start prior for
   frontier closed models. A `measured` record for the same model **overrides** it.
3. **`heuristic`** — interpolated fallback for an unknown id; marked explicitly.

`measured` and `benchmark` vectors are **not on the same scale** (different question
mixes, different grading). Treat `benchmark` as a prior; prefer `measured` when both
exist for a model.

## NA imputation

Public benchmarks systematically omit some capabilities (creative writing is rarely
benchmarked; Google does not publish instruction-following or agentic numbers for
most Gemini tiers). For a missing coordinate we impute the **mean of the model's
known coordinates**, list the coordinate in `imputed_capabilities`, and set its
`confidence` to `low`. This keeps the vector usable by the router while flagging the
estimate as soft.

## Contributing

Run `brick skills extract <model> --publish` (opt-in consent prompt) to measure a new
model on the frozen probe set and upsert a `measured` record to
`regolo/brick-skill-tables`. You may also open a PR adding a `<model>.json` here.
