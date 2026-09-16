# `@regoloai/brick`

The Brick 3.0 command-line client manages explicit router profiles.

```bash
npm install --global ./regoloai-brick-runtime-linux-x64-3.0.0.tgz \
  ./regoloai-brick-3.0.0.tgz

brick profile create work
brick profile edit work
brick start work
brick stop work
```

This branch is an unpublished release candidate; see the root README for
building these two tarballs.

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
the user machine. Linux x64 is the current execution-tested target.

See [installation and recovery](../../docs/quickstart/serve.md).
