# `apps/cli/`: `brick` CLI (`@regoloai/brick`)

TypeScript / oclif / ink companion CLI that self-hosts the Brick router and wires it into
**Claude Code** and **OpenAI Codex** with one command each.

## Install

Install the published CLI:

```bash
npm install -g @regoloai/brick
brick --version
```

For development from source:

```bash
git clone https://github.com/regolo-ai/brick-SR1.git
cd brick-SR1/apps/cli
npm install
npm run build
npm link        # makes `brick` available on $PATH
```

Requires Node 20 or >= 22 and Docker.

## Commands

### Claude Code

| Command | Purpose |
|---------|---------|
| `brick claude on` | Wires `ANTHROPIC_BASE_URL` in `~/.claude/settings.json`, auto-starts the router |
| `brick claude off` | Reverts `ANTHROPIC_BASE_URL`, optionally stops the router |
| `brick claude mode` | Interactive picker for the routing mode |
| `brick claude eco\|lite\|mid\|pro\|max` | Set the routing mode directly (see the [5 modes](../../README.md#the-5-modes)) |
| `brick claude status [--once]` | Live dashboard (or one-shot) of routing stats, effort mix, and estimated savings |
| `brick claude settings show` | Print current context-awareness + classifier compute settings |
| `brick claude settings context` | Configure how many recent turns feed the complexity classifier |
| `brick claude settings compute` | Switch the classifier between hosted (Regolo) and local (Docker sidecar) |
| `brick claude settings subagents` | Configure per-subagent routing behavior |

Full walkthrough: [Brick + Claude Code](../../README.md#-brick--claude-code) in the root README.

Practical external guide: [Brick + Claude Code CLI — AI routing and cost control](https://regolo.ai/brick-claude-code-cli-guide/).

### OpenAI Codex

| Command | Purpose |
|---------|---------|
| `brick codex on` / `brick codex off` | Same wiring pattern as `claude on/off`, for Codex |
| `brick codex mode` / `brick codex eco\|lite\|mid\|pro\|max` | Routing mode picker / direct set |
| `brick codex status [--once]` | Live dashboard for Codex routing |
| `brick codex settings` | Interactive Codex settings menu |
| `brick codex settings show\|context\|compute\|model-routing\|models\|thinking` | Codex-specific context-awareness, classifier compute, model pool, and thinking-budget routing |
| `brick codex settings mode off\|sticky\|smartsqueeze\|orchestrator` | Configure cache-aware multi-turn routing |

Codex profiles default to the last 8 conversation turns for classification and
Smartsqueeze for cache-aware model continuity. Tool-result compaction is currently
served only on the Claude/Anthropic path.

### Router / general

| Command | Purpose |
|---------|---------|
| `brick init [profile]` | Guided wizard → creates `~/.brick/profiles/<name>/{config.yaml, docker-compose.yml, .env}` |
| `brick serve [profile]` | `docker compose up -d` for the active profile |
| `brick chat` | TUI chat (ink: bottom input + scrolling history, Claude Code-style). Includes an optional **BABL** multi-model debate mode (`/BABL` in-chat) that runs several models as agents plus a moderator and synthesizes an answer |
| `brick generate "<prompt>"` | One-shot completion (stdout) |
| `brick route "<prompt>"` | Show routing decision (selected backend + latency); `--no-generate` skips generation |
| `brick status` | Active profile + container state |
| `brick logs` | Tail container logs |
| `brick stop` / `brick down` | Stop / down docker compose |
| `brick config new\|use\|edit\|list\|remove\|rename [profile]` | Manage YAML profiles |
| `brick add\|remove provider\|model\|decision\|plugin` | Edit current profile interactively |
| `brick skills extract` | Extract a skill-vector table from benchmark results for the router's model catalog |

Common flags: `--profile <name>`, `--thinking off\|low\|med\|high\|auto`, `--json`.

## Configuration

```
~/.brick/
├── state.json                  # {activeProfile, runningProfile}
└── profiles/
    └── <name>/
        ├── config.yaml         # router config (schema mirrors apps/router/config/config.yaml)
        ├── docker-compose.yml  # rendered from templates/*.hbs
        ├── .env                # API keys (REGOLO_API_KEY, OPENROUTER_API_KEY, …) chmod 600
        └── models/             # optional Docker volume mount for cached HF models
```

Environment overrides:
- `BRICK_HOME`: alternate root (default `~/.brick`).
- `BRICK_PROFILE`: alternate active profile (default = `state.json`'s `activeProfile`).
- `BRICK_IMAGE`: alternate Docker image for `brick serve` (default `docker.io/regolo/brick:latest`).
- `BRICK_CC_TAG`: alternate image tag for the Claude/Codex router + classifier sidecar containers.
- `REGOLO_API_KEY`: provider key (read by the router via `Authorization: Bearer ...`).
- `ANTHROPIC_BASE_URL`, `ANTHROPIC_API_KEY`: used by Claude Code passthrough.
- `HF_TOKEN`: optional, for gated/private Hugging Face model downloads.

## Build & test

```bash
cd apps/cli
npm install
npm run build         # tsc -b → dist/
npm run lint          # tsc --noEmit
npm test              # vitest
npm run test:random   # custom random-session harness (test/random.ts)
```

After build, the CLI is invocable as `./bin/run.js`.

## Publishing

The package is scoped (`@regoloai/brick`) and published with `--access public`. CI handles publishing on tag `v*` (see `.github/workflows/npm-publish.yml`), installing from the repo-root `package-lock.json` (npm workspaces) rather than a per-package lockfile.

Local dry-run:

```bash
npm pack
# inspect the tarball before npm publish
```

## Source layout

```
apps/cli/
├── bin/
│   ├── run.js                  # oclif entry (production)
│   └── dev.js                  # oclif entry (ts-node loader)
├── src/
│   ├── commands/               # oclif commands (chat, serve, route, init, …)
│   │   ├── add/, remove/       # topic groups
│   │   ├── config/             # profile management
│   │   ├── claude/             # Claude Code wiring: on/off/mode/status/settings
│   │   ├── codex/              # OpenAI Codex wiring: on/off/mode/status/settings
│   │   └── skills/             # skill-vector table extraction
│   ├── lib/
│   │   ├── client/             # OpenAI-compatible HTTP client (SSE streaming)
│   │   ├── chat-tui/           # ink components (App, Welcome, BABL pane, SlashPopup, …)
│   │   ├── claude-tui/         # ink dashboard for `brick claude status`
│   │   ├── claude/, codex/     # bootstrap, settings, mode, and metrics logic
│   │   ├── config/             # paths, load, validate (zod schema), migrate
│   │   ├── config-ai/          # interactive `config ai` agent (React/ink)
│   │   ├── docker/             # image / compose / run helpers
│   │   ├── ui/                 # banners, colors
│   │   └── wizard/             # guided init prompts
│   └── hooks/
│       └── init.ts             # oclif lifecycle hook (legacy migration, banner)
├── templates/
│   ├── docker-compose.yaml.hbs         # Handlebars template for `brick init`
│   ├── claude-default.docker-compose.yaml.hbs  # compose for `brick claude on` (reused by `brick codex on`)
│   ├── claude-default.config.yaml, codex-default.config.yaml  # default router configs
│   └── skill-tables/                   # per-model capability vectors
├── test/
│   ├── random.ts               # random-session test harness
│   └── fixtures/prompts.json
├── package.json
└── tsconfig.json
```

## Related

- Router architecture and config knobs: [apps/router/README.md](../router/README.md).
- One-line Docker quickstart (no CLI): [docs/quickstart/quick.md](../../docs/quickstart/quick.md).
- Full CLI walkthrough: [docs/quickstart/serve.md](../../docs/quickstart/serve.md).
- Claude Code integration (setup, modes, effort picker, dashboard): [root README](../../README.md#-brick--claude-code).
