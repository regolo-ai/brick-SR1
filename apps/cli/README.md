# `@regoloai/brick`

The Brick 4.0 command-line client manages explicit router profiles.

```bash
npm install --global @regoloai/brick

brick profile create work
brick profile edit work
brick start work
brick stop work
```

The installer selects the verified bundled runtime for the current platform.
For native Codex subscription routing: `codex login` then `brick start codex`
(default pool `gpt-6.1-terra`/`gpt-6-luna`); use `--reset-pool` to migrate an
existing Codex profile to that pool without touching providers or credentials.

## Commands

| Command | Purpose |
|---|---|
| `brick profile create <name>` | Create a custom profile after validating the remote skill table |
| `brick profile edit <name>` | Edit providers, model selection, routing, and reasoning settings |
| `brick profile show <name>` | Show a profile; supports `--raw`, `--json`, and `--path` |
| `brick profile list` | List custom and official profiles |
| `brick profile pricing [name]` | Show the model prices a profile uses; `--sync` refreshes them from public sources, `--json`/`--all` for scripts |
| `brick profile rename <old> <new>` | Rename a stopped custom profile |
| `brick profile delete <name> -y` | Delete a stopped custom profile |
| `brick start <profile>` | Synchronize skill vectors, start the router, and connect an official harness |
| `brick restart <profile>` | Synchronize and restart a profile while preserving harness wiring |
| `brick stop <profile>` | Stop a router; for Codex, detach future launches while keeping the current bridge alive |
| `brick clear <profile>` | Remove runtime state while preserving configuration, credentials and history |
| `brick migrate <profile>` | Rewrite a legacy profile to the current format; `--dry-run` previews it |
| `brick update` | Update CLI and native runtime together, retaining a rollback bundle |

The authoritative table is the public Hugging Face `skill_vectors.csv`. Brick
keeps one private (`0600`) cached copy for network fallback; it does not bundle
per-model JSON cards or provide local measurement or publishing commands.

Model prices are refreshed on demand: `brick start` launches a detached watcher
that rewrites the profile's `pricing.yaml` immediately and then hourly, reading
Regolo's public price list (EUR, converted with the ECB reference rate) and the
public OpenRouter catalogue (USD). No API key is required, and prices you edit
by hand are never overwritten.

Requires Node.js 20 or 22+ and Python 3 with `venv`. The npm installer downloads
and verifies the pinned SystemOne checkpoint and the platform runtime, then
creates a managed Python environment with the pinned torch and transformers
build that matches the detected GPU driver. No compiler or Docker is required on
the user machine. Linux x64, Linux arm64, macOS x64, and macOS arm64 artifacts
are execution-tested before publication.

See [installation and recovery](../../docs/quickstart/serve.md).
