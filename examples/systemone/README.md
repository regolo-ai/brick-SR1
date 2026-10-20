# SystemOne quickstart scripts

Terminal demos for `regolo/brick-sysone-V1`. Copy these files, or paste the
blocks below into the model card.

## 1. Install

```bash
bash examples/systemone/install.sh
```

The script creates `.venv-systemone`, installs PyTorch from the index that
matches the local driver (`cu128` for driver 570+, `cu126` for 560-569, CPU
otherwise), then installs the pinned inference stack and downloads the
checkpoint at revision `9263a397a366ee22921214ddeebab1f5e4e8facd`.

Useful overrides: `VENV=/path/to/venv`, `FORCE_CPU=1`, `TORCH_VERSION=2.11.0`.

## 2. Terminal chat

```bash
.venv-systemone/bin/python examples/systemone/chat.py
```

```
query> write a python parser that streams csv rows
  instruction_following 0.5117  ##########..........
  coding                0.9258  ###################.
  math_reasoning        0.0903  ##..................
  world_knowledge       0.1157  ##..................
  planning_agentic      0.0630  #...................
  creative_synthesis    0.0198  ....................
  vector: [0.5117, 0.9258, 0.0903, 0.1157, 0.0630, 0.0198]
```

One-shot and machine-readable modes:

```bash
.venv-systemone/bin/python examples/systemone/chat.py "prove that sqrt 2 is irrational" --json
```

`--device cpu|cuda|auto`, `--model` for a local checkout, and
`BRICK_SYSTEMONE_THREADS` (default `min(4, cores)`) are also available.

## What the numbers mean

Order is fixed: `instruction_following`, `coding`, `math_reasoning`,
`world_knowledge`, `planning_agentic`, `creative_synthesis`. Each value is an
independent sigmoid in `[0, 1]`; the vector is a capability profile, not a
probability distribution over models.

Brick routes on this vector by comparing it with the skill vector of every
active model, so the vector is only meaningful relative to those reference
vectors. Input is truncated to 8192 tokens; the router classifies only the last
user message, never system or assistant turns.

Paste-ready model card section: `card.md`.
