# Router comparisons

These scripts retain the local Dataset A comparison workflows. They are
research tools, separate from the npm runtime. Run them only when you intend
to download the referenced datasets and model checkpoints. Publishing scripts
such as `aggregate_and_push.py` write to remote repositories when executed.

Install the optional, locked comparison dependencies from the repository root:

```bash
uv sync --frozen --group baselines
```

RouteLLM is pinned to commit
`0b64fdafe049e596a3f5657c219329f24af24198` in `uv.lock`. The unused vendored
copies of RouteLLM, FrugalGPT and cascade-routing have been removed. The latter
two wrappers load external data with Transformers and scikit-learn; they do
not import those upstream libraries.

Set `HF_TOKEN` through your environment if dataset access requires it. Set
`BRICK_BASELINE_OUTPUT` to a writable output directory; the default for the
three external comparison runners is `./baseline-output`.

```bash
uv run --frozen --group baselines python packages/evals/baselines/run_routellm.py

BRICK_FRUGAL_STRATEGY=/absolute/path/HEADLINES_Model2024 \
  uv run --frozen --group baselines python packages/evals/baselines/run_frugalgpt.py

BRICK_ROUTERBENCH_CSV=/absolute/path/routerbench_0shot.csv \
  uv run --frozen --group baselines python packages/evals/baselines/run_cascade_routing.py
```

FrugalGPT requires the externally supplied HEADLINES strategy and scorer
checkpoint. Its scorer is transferred across tasks and model families, using
cached Dataset A responses. The cascade-routing comparison is an adapted
quality/cost selector: it fits logistic regressions on RouterBench embeddings
and transfers the model tiers. It does not reproduce the upstream cascade
algorithm. RouteLLM includes both its binary selector and a custom two-stage
ternary tournament. These distinctions matter when interpreting results.

The remaining sweep and aggregation scripts preserve the historical experiment
entrypoints. Their dataset, provider, checkpoint and output settings must be
reviewed before executing an experiment. Offline unit tests do not establish
reproduction of these external benchmark results. Historical numerical results
are not a release acceptance criterion for the native runtime.
