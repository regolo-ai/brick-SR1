# Run Brick locally

The native npm bundle contains the CPU runtime. It requires Node.js 20 or 22+;
users do not need Docker, Python, Go, Rust, or a compiler. Linux x64 is the
current verification target: Ubuntu 24.04, glibc 2.39 or newer. The Linux
Candle library requires glibc 2.39; musl/Alpine and older glibc distributions
are not supported by this artifact. The installer checks that the executable
loads before downloading weights. Other platform packages require execution
testing before publication.

```bash
npm install --global ./regoloai-brick-runtime-linux-x64-3.0.2.tgz \
  ./regoloai-brick-3.0.2.tgz
brick profile create work
brick profile edit work
brick start work
brick status work
brick logs work
brick restart work
brick stop work
```

Installation downloads the pinned ModernBERT assets, verifies SHA-256 checksums,
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

Profiles live in `~/.brick/profiles/<name>` (or `BRICK_HOME/profiles/<name>`):

- `config.yaml` and `.env`: routing settings and credentials.
- `backups/`: exact configuration and credential backups from migrations.
- History, economics snapshots and pricing: persistent profile data.
- `runtime/`: process identity, immutable configuration snapshots and logs.

`brick clear <profile>` stops the runtime and clears its operational state.
Configuration, credentials and persistent history remain. `brick stop codex`
detaches future Codex launches but keeps the runtime for open sessions;
`brick clear codex` also stops that runtime.

The complexity classifier and final models use configured APIs. Classifier,
local harness and provider credentials are separate. `use_client_key: true`
selects the current request credential explicitly and never falls back to a
server key. Endpoint domains do not select an authentication mode.

Legacy profiles receive a versioned migration with backups. Profiles that need
the retired local complexity server must first be configured with an API
endpoint
and credential. Unknown fields produce an error before the configuration is
modified. Existing legacy containers are not managed by the native runtime.

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
