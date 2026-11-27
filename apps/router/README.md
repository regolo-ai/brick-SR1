# Brick local runtime

The Go gateway hosts SystemOne routing, protocol adapters, streaming, tools,
multimodal transport, history, and token/cost accounting. The
[SystemOne module](systemone/README.md) runs a persistent local
PyTorch/Transformers worker and verifies the pinned checkpoint assets.
Generation uses the selected provider. Native provider compaction remains part
of the transport; local compaction and conversation routing state are absent.

From the repository root:

```bash
make test-router
python3 scripts/build_runtime.py
```

The build uses the Go lockfile and writes a target-specific runtime bundle to
`dist/runtime-<platform>-<arch>`. It contains the gateway and Python requirements.
Set `BRICK_SYSTEMONE_PYTHON` to an interpreter with those dependencies installed.

Runtime controls include `--config`, `--data-dir`, `--model-dir`, `--port`,
`--instance-id`, and `--profile`. `--validate-config` validates without contacting
providers. `--check-model` verifies assets and performs local inference.
`--route-test` returns the query vector, scaled vector, knob, distances, and
selected model. `--route-candidates` restricts that diagnostic's candidates.

See [local lifecycle](../../docs/quickstart/serve.md) for installation and profile
management. Training and evaluation workspaces remain separate from this runtime.
