# `@regoloai/brick`

The Brick 3.0 command-line client manages explicit router profiles.

```bash
npm install --global @regoloai/brick@3.0.1

brick profile create work
brick profile edit work
brick start work
brick stop work
```

The installer selects the verified native runtime for the current platform.

## Commands

| Command | Purpose |
|---|---|
| `brick profile create <name>` | Create a custom profile after validating the remote skill table |
| `brick profile edit <name>` | Edit providers, model selection, routing, and reasoning settings |
| `brick profile show <name>` | Show a profile; supports `--raw`, `--json`, and `--path` |
| `brick profile list` | List custom and official profiles |
| `brick profile rename <old> <new>` | Rename a stopped custom profile |
| `brick profile delete <name> -y` | Delete a stopped custom profile |
| `brick start <profile>` | Synchronize skill vectors, start the router, and connect an official harness |
| `brick restart <profile>` | Synchronize and restart a profile while preserving harness wiring |
| `brick stop <profile>` | Stop a router; for Codex, detach future launches while keeping the current bridge alive |
| `brick clear <profile>` | Remove runtime state while preserving configuration, credentials and history |
| `brick update` | Update CLI and native runtime together, retaining a rollback bundle |

The authoritative table is the public Hugging Face `skill_vectors.csv`. Brick
keeps one private (`0600`) cached copy for network fallback; it does not bundle
per-model JSON cards or provide local measurement or publishing commands.

Requires Node.js 20 or 22+. The npm installer downloads and verifies the pinned
ModernBERT assets and CPU runtime; no compiler, Docker or Python is required on
the user machine. Linux x64, Linux arm64, macOS x64, and macOS arm64 artifacts
are execution-tested before publication.

See [installation and recovery](../../docs/quickstart/serve.md).
