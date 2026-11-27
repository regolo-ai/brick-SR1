# Run Brick locally

The npm bundle contains the Go gateway and an embedded local SystemOne worker.
It requires Node.js 20 or 22+, Python, PyTorch, and Hugging Face Transformers.
Inference follows the SystemOne reference stack: FP32 on CPU, BF16 on CUDA,
FlashAttention 2 when available on CUDA, and SDPA otherwise. Candle is not linked
into the production gateway. Linux x64 is the current verification target;
other platform packages require execution testing before publication.

Brick prepares its own Python environment. The installer creates a managed
virtual environment under `~/.brick/runtime/<version>/venv`, installs the pinned
`torch==2.11.0` and `transformers==5.20.2` (CUDA wheels when `nvidia-smi` reports
a GPU, CPU wheels otherwise), verifies that the stack imports, and reuses it on
every later install and start. Python 3 is required; `python3-venv` must be
available on Debian/Ubuntu.

Environment overrides:

- `BRICK_SYSTEMONE_PYTHON`: use a specific interpreter and skip managed installs.
- `BRICK_PYTHON`: interpreter used to create the managed venv (default `python3`).
- `BRICK_CUDA=0`: force CPU wheels even when a GPU is present.
- `BRICK_SKIP_PYTHON_INSTALL=1`: rely on an interpreter that already imports
  torch and transformers.
- `BRICK_HOME`: base directory for the managed runtime (default `~/.brick`).

The installer picks the CUDA wheel that the detected driver and GPU can load.
The PyPI build of `torch==2.11.0` targets CUDA 13 (driver 580+), so the installer
pulls `torch==2.11.0+cu128` from the PyTorch `cu128` index (CUDA 12.8), which
covers both pre-Blackwell and Blackwell GPUs: driver 570+ installs `cu128`,
while driver 560-569 uses the `cu126` wheel. The `cu126` wheel predates
Blackwell (compute capability 12.0), so Blackwell GPUs on those drivers fall
back to CPU wheels. Drivers below 560 also fall back
to CPU, and Brick logs that SystemOne will run on CPU. FlashAttention 2 is used
only when the `flash_attn`
wheel is importable; a CUDA toolkit (`CUDA_HOME`) is required to build it,
otherwise SDPA is used.

GPU hosts must expose `/dev/nvidia0`, `/dev/nvidiactl` and the `nvidia-uvm`
device node; some provider images install the driver kernel modules without
`nvidia-uvm`, in which case `nvidia-smi` works but CUDA cannot initialize and
Brick falls back to CPU wheels. Run
`scripts/test_systemone_cuda.py` (SkyPilot wrapper in
`scripts/skypilot-systemone-cuda.yaml`) on a candidate GPU host.

The runtime and the Python workspace share one dependency set, pinned through
`[tool.uv] constraint-dependencies`: `torch==2.11.0`, `transformers==5.20.2`,
`safetensors==0.8.0`, `tokenizers==0.23.3`, `numpy==1.26.4` and
`huggingface-hub==2.2.0`. The workspace resolves every pin from PyPI, so
`uv sync` installs the PyPI `torch==2.11.0` wheel; the managed runtime installer
above is the only place that selects the CUDA 12.8 or 12.6 wheel matching the
detected driver. `numpy` stays on the 1.26 line because the optional RouteLLM
baseline requires `numpy<2`.

`torch==2.11.0` is the newest release with a `cu128` wheel; switching from the
previous `2.13.0` pin leaves CPU fp32 logits bit-identical (version drift 0e0),
including with `transformers==5.20.2`.

Measured GPU numerics (RTX PRO 6000 Blackwell, `scripts/test_systemone_cuda.py`):
CPU fp32 versus CUDA fp32 differ by 6e-6 on logits of magnitude ~10, CUDA fp32
SDPA and eager agree to 6e-6, and CUDA bf16 stays within ~2% relative of the CPU
fp32 reference with an unchanged capability ranking. Near-tie routing decisions
can therefore differ between a CPU and a bf16 CUDA deployment.

The pinned checkpoint is public, so no Hub
credentials are required; an optional `HF_TOKEN` is forwarded when present. The
token is never written to the completion marker. To install without downloading,
set `BRICK_MODEL_ASSETS` to a directory containing the exact pinned assets;
checksums are still verified.

```bash
npm install --global ./regoloai-brick-runtime-linux-x64-4.0.0.tgz \
  ./regoloai-brick-4.0.0.tgz
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
and order; the numeric routing preference becomes `skill_router.knob`. A key in
`provider_endpoints[].api_key` is adopted as the model's explicit `access_key`
before the caller-key policy is decided, so it is never treated as a client key.
Obsolete difficulty, calibrated-math, automatic-effort and local cache-management
settings are removed. `keyword_rules` with `mode: override` are converted to
`skill_router.keywords`; rules with `mode: bias` or no mode stop the migration
because a soft bias cannot become a strict override. Preview the result with
`brick migrate <profile> --dry-run`. Incompatible vectors stop migration before
writing files. Repeating migration is a no-op. Existing legacy containers remain
outside the native runtime's lifecycle.

Managed deployments that run the gateway binary directly can migrate a file with
`brick-runtime --config config.yaml --migrate-config -` (stdout) or
`--migrate-config migrated.yaml`. Add `--strict-config` to treat every removed
field as an error, so a deployment cannot start on a partially migrated profile.

`brick route "your query" --json` returns local vectors, knob, distances and selected
model without generation. `--effort low|medium|high|xhigh|max` overrides the profile
knob for that diagnostic, and `--knob <number in [-1,1]>` sends the explicit
`X-Brick-Knob` header instead (it takes precedence over `--effort`).
`/api/v1/diag/systemone` reports engine readiness and the
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
