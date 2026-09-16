# Brick

Brick is a self-hosted, OpenAI-compatible router for selecting models by
capability, complexity, cost, and reasoning behavior.

## Install

Brick 3.0.1 is distributed as a small JavaScript CLI plus a native runtime for
each supported platform. The installer selects the matching runtime package;
users do not need Docker, Python, Go, Rust, or a compiler.

Install the current release:

```bash
npm install --global @regoloai/brick@3.0.1
```

For local release verification on Linux x64:

```bash
npm ci --ignore-scripts
python3 scripts/build_runtime.py
mkdir -p dist/tarballs
npm pack ./dist/runtime-linux-x64 --pack-destination dist/tarballs
npm pack ./apps/cli --pack-destination dist/tarballs
```

Copy the two tarballs to the user machine and install them together:

```bash
npm install --global ./regoloai-brick-runtime-linux-x64-3.0.1.tgz \
  ./regoloai-brick-3.0.1.tgz
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
