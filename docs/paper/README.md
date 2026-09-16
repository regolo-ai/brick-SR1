# Paper source and figures

`paper.tex` and `paper.pdf` preserve the research publication. Its numerical
results describe the historical experiments, not a fresh npm runtime benchmark.

The retained figure generators are:

- `figures/generate_figures.py`: cost frontier, training curves and latency CDF.
- `figures/capability_views.py`: the worked-example capability visualization.
- `figures/aggregate_latency.py`: latency inputs and LaTeX tables.
- `figures/extract_example_query.py`: the worked example from inference traces.

The first two use the checked-in numeric inputs and logos. Training curves use
`_wandb_cache_modernbert.json` when present. Regenerating that cache contacts
Weights & Biases and needs credentials. The input cache is a reproducibility
asset; it is not part of the npm package.

The last two require `BRICK_RESEARCH_INPUT`, pointing to a research directory
with `external_comparison/predictions`, `scientificv1/data/inference` and the
production `router_requests.jsonl` trace. These inputs are not redistributed.
Outputs go beside the generators. Do not treat missing traces as a successful
reproduction of the paper's measurements.

Build the paper with a LaTeX installation from this directory, for example:

```bash
latexmk -pdf -output-directory=build paper.tex
```

The runtime release does not require LaTeX, figure regeneration or remote
research services.
