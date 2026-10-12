# Run Brick locally

The npm bundle contains the Go gateway and an embedded local SystemOne worker.
It requires Node.js 20 or 22+, Python, PyTorch, and Hugging Face Transformers.
Inference follows the SystemOne reference stack: FP32 on CPU, BF16 on CUDA,
FlashAttention 2 when available on CUDA, and SDPA otherwise. Candle is not linked
into the production gateway. Linux x64 is the current verification target;
other platform packages require execution testing before publication.

Before installation, prepare the Python environment and export its interpreter:

```bash
python3 -m venv /path/to/systemone-env
/path/to/systemone-env/bin/python -m pip install -r apps/router/systemone/requirements.txt
export BRICK_SYSTEMONE_PYTHON=/path/to/systemone-env/bin/python
export HF_TOKEN=your_hugging_face_token
```

Keep `BRICK_SYSTEMONE_PYTHON` set when installing and starting Brick. Without it,
the runtime uses `python3` on PATH. The installer uses `HF_TOKEN` for private
checkpoint access without writing the token to its completion marker. To install
without downloading, set `BRICK_MODEL_ASSETS` to a directory containing the exact
pinned assets; checksums are still verified.

```bash
npm install --global ./regoloai-brick-runtime-linux-x64-3.1.1.tgz \
  ./regoloai-brick-3.1.1.tgz
brick profile create work
brick profile edit work
brick start work
brick status work
brick logs work
brick restart work
brick stop work
```

Installation downloads the pinned SystemOne v2 assets, verifies SHA-256 checksums,
and checks real inference before completing. Installation requires network
access and approximately 0.8 GB for model assets. The assets belong to the npm
installation and are shared across profiles. An installation made with lifecycle
scripts disabled is incomplete: reinstall with scripts enabled. Starting Brick
never downloads model weights.

`start` launches a detached process on loopback and waits for routing readiness
before connecting an official harness. Nothing starts automatically after a
computer reboot. `restart` validates the candidate configuration before stopping
the current process; a failed replacement attempts to restore the previous
bundle and configuration. Use `brick logs <profile>` for startup diagnostics.

A reachable `/health` endpoint does not imply that classification is ready.
Its `routing_ready` field reports model initialization. Classification-dependent
requests return HTTP 503 if initialization fails; direct Codex forwarding
remains
available.

For scripts and agents, `brick status <profile> --for-agent` returns the same
state as the live dashboard as one JSON object. It needs no TTY, exits `0` even
when the router is unreachable (fields become `null`), and takes precedence over
`--json` and `--static`. See the Observability section of the README for the
field reference.

Profiles live in `~/.brick/profiles/<name>` (or `BRICK_HOME/profiles/<name>`):

- `config.yaml` and `.env`: routing settings and credentials.
- `backups/`: exact configuration and credential backups from migrations.
- History, economics snapshots and pricing: persistent profile data.
- `runtime/`: process identity, immutable configuration snapshots and logs.

`brick clear <profile>` stops the runtime and clears its operational state.
Configuration, credentials and persistent history remain. `brick stop codex`
detaches future Codex launches but keeps the runtime for open sessions;
`brick clear codex` also stops that runtime.

SystemOne runs locally. Generation providers use configured credentials.
`use_client_key: true` selects the current request credential explicitly and never
falls back to a server key. Endpoint domains do not select an authentication mode.

Legacy profiles migrate to `config_version: 2` with exact backups and atomic
replacement. Provider credentials, pools and skill vectors retain their values
and order; the numeric routing preference becomes `skill_router.knob`.
Obsolete difficulty, calibrated-math, keyword, automatic-effort and local
cache-management settings are removed. Incompatible vectors stop migration before
writing files. Repeating migration is a no-op. Existing legacy containers remain
outside the native runtime's lifecycle.

`brick route "your query" --json` returns local vectors, knob, distances and selected
model without generation. `--effort low|medium|high|xhigh|max` overrides the profile
knob for that diagnostic. `/api/v1/diag/systemone` reports engine readiness and the
pinned model identity. Token usage, costs and routing/provider/overall latencies
remain available through the statistics APIs.

## Update and restore

`brick update --to <version>` saves the installed CLI, runtime and model assets
under `~/.brick/bundles/` before installing the new version. Active profiles are
restarted only after installation succeeds. Installation failure restores the
previous files; startup failure attempts to launch the saved runtime. A direct
`npm install --global` does not restart profiles or alter harness wiring.

Keep the reported backup directory until the new version has been verified.
It contains the previous `cli/`, `runtime/`, and `restore.json` paths. Do not
remove assets referenced by an active profile's `runtime/process.json`.

To restore the complete saved installation, run
`brick update --rollback /absolute/path/to/bundle`, then explicitly restart
the desired profiles. The rollback command leaves running profiles untouched.
