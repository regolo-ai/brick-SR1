# Brick

Brick is a self-hosted, OpenAI-compatible router for selecting models by
capability, complexity, cost, and reasoning behavior.

## Install

Brick 3.0.2 includes a JavaScript CLI and verified native runtimes for every
supported platform. The installer selects the matching bundled runtime; users
do not need Docker, Python, Go, Rust, or a compiler.

Install the current release:

```bash
npm install --global @regoloai/brick@3.0.2
```

For local release verification on Linux x64:

```bash
npm ci --ignore-scripts
python3 scripts/build_runtime.py
mkdir -p dist/tarballs
mkdir -p apps/cli/runtimes
cp -R dist/runtime-linux-x64 apps/cli/runtimes/linux-x64
npm pack ./apps/cli --pack-destination dist/tarballs
```

Copy the tarball to the user machine and install it:

```bash
npm install --global ./regoloai-brick-3.0.2.tgz
```

Installation downloads and verifies the pinned ModernBERT assets. Node.js 20
or 22+ is required.

## Brick 3.0 workflow

Brick stores independent profiles under `~/.brick/profiles`. Profile names are
explicit for every lifecycle operation.

```bash
brick profile create work
brick profile edit work
brick profile show work
brick profile list

brick start work
brick restart work
brick stop work
brick clear work
brick update
```

`clear` removes operational state while preserving configuration, credentials
and history. `stop codex` detaches future launches while preserving the runtime
used by open sessions; `clear codex` also stops it. `update --to <version>`
updates the CLI and runtime together and retains a rollback bundle.
Use `brick update --rollback /absolute/path/to/bundle` to restore that bundle,
then `brick restart <profile>` to switch a running profile. Direct npm
installation and rollback never restart profiles automatically.

See [installation, lifecycle, migration and recovery](docs/quickstart/serve.md).

## Quick start with coding agents

Configure the official profile, start it, then open a new agent session. Brick
runs one profile at a time.

### Claude Code

```bash
brick profile edit claude  # configure providers, models, routing, and thinking
brick start claude         # start the router and connect Claude Code
```

In a new Claude Code session, select `brick-claude` in the `/model` picker.
Use `brick profile edit claude` to change routing, models, or thinking settings,
then `brick restart claude` to apply changes to a running router. Inspect the
profile with `brick status claude` or its non-interactive form,
`brick status claude --static`. Disconnect with `brick stop claude`; use
`brick clear claude` to remove its runtime while preserving the profile.

### Codex

```bash
brick profile edit codex   # configure providers, models, routing, and thinking
brick start codex          # start the router and connect Codex
```

Open a new Codex session after starting the profile. Use `brick profile edit
codex` and `brick restart codex` for changes, and `brick status codex` (or
`brick status codex --static`) for observability. `brick stop codex` restores
future launches while retaining the local bridge used by the current thread;
`brick clear codex` also terminates that bridge and removes the runtime.

## Skill vectors

[`skill_vectors.csv`](https://huggingface.co/datasets/regolo/brick-skill-tables/blob/main/skill_vectors.csv)
is the only authoritative skill-vector source. Brick refreshes it during profile
lifecycle commands and caches the last valid copy at
`~/.brick/cache/skill_vectors.csv` for network outages. A malformed remote table
is rejected in full and never replaced by cached data.

The six canonical capabilities are `coding`, `creative_synthesis`,
`instruction_following`, `math_reasoning`, `planning_agentic`, and
`world_knowledge`.

The official `claude` and `codex` profiles are materialized automatically. They
begin dormant, without bundled vectors; select models with `brick profile edit
claude` or `brick profile edit codex` before starting them. Starting an official
profile connects its corresponding harness after the router becomes healthy.

The [native Codex Responses integration](docs/quickstart/codex-native.md) keeps
tools in the original session and isolates provider credentials. Live provider
checks require separate credentials; offline protocol tests do not establish
live provider availability.

## Development

```bash
make install
make test
make lint
```

The stable npm package is published only from `main`. See [AGENTS.md](AGENTS.md)
for contribution and publication rules.

## License

Apache-2.0. See [LICENSE](LICENSE).

## Repository history

![GitHub star history](docs/assets/star-history/star-history-light.svg#gh-light-mode-only)
![GitHub star history](docs/assets/star-history/star-history-dark.svg#gh-dark-mode-only)
