# Brick CPU runtime

The Go HTTP runtime hosts routing, protocol adapters, streaming, tool transport,
sticky conversations, compaction, history and statistics. The small Candle
binding loads the pinned ModernBERT checkpoint and returns six probabilities.
Complexity classification and final generation use configured remote APIs.

From the repository root:

```bash
python3 scripts/build_runtime.py
make test-router
make test-rust
```

The build uses the Cargo and Go lockfiles and writes a target-specific npm
runtime package under `dist/runtime-<platform>-<arch>`. The shared inference
library sits beside the executable, with a relative loader search path.

Runtime controls include `--config`, `--data-dir`, `--model-dir`, `--port`,
`--instance-id` and `--profile`. `--validate-config` parses and validates a
configuration without contacting providers; `--check-model` loads the local
checkpoint and runs real inference. No model download or subprocess classifier
runs during startup.

See [local lifecycle](../../docs/quickstart/serve.md) for installation and
profile management. The separate deployment service is outside this refactoring.

## Checkpoint label compatibility

The pinned checkpoint emits instruction following, coding, math reasoning,
world knowledge, agentic planning and creative synthesis, in that order.
Routing skill vectors can use a different configured order; the router maps
between the two explicitly. Earlier templates incorrectly declared alphabetical
checkpoint labels. The CLI repairs that known declaration with a backup while
preserving skill-vector order and values. Unknown label declarations are rejected.
This separate compatibility correction can change model choices for affected
profiles. The checkpoint, six raw probabilities and historical softmax algorithm
are unchanged and remain covered by the pre-refactoring numerical corpus.
