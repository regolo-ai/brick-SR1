# Quickstart B. Install and use the `brick` CLI

Goal: install `@regolo-ai/brick` from npm, run a guided init, start the gateway, chat with it. Total time: ~5 minutes.

## Prerequisites

- Node.js ≥ 18 (`node --version`).
- Docker running (the CLI orchestrates Docker compose under the hood).
- A `REGOLO_API_KEY` (or set up your own providers during `brick init`).

## Install

Build from source (the npm package is not yet published):

```bash
git clone https://github.com/regolo-ai/brick-SR1 && cd brick-SR1
cd apps/cli && npm install && npm run build
npm link                # exposes `brick` globally
brick --version
```

Once published (at the next `v2.1.0` tag), the one-line install will be:

```bash
npm install -g @regolo-ai/brick
```

## Init a profile

```bash
brick init
```

The wizard prompts for:
- Profile name (e.g. `dev`, `prod`).
- API keys (stored in `~/.brick/profiles/<name>/.env`, mode 0600).
- Provider selection (Regolo, OpenAI, OpenRouter, local).
- Backend models to expose in the pool.
- Routing knobs (capability/complexity classifiers, cost penalty β, etc.).

Result on disk:

```
~/.brick/
├── state.json                          # active/running profile
└── profiles/
    └── dev/
        ├── config.yaml                 # router config
        ├── docker-compose.yml          # rendered template (mounts config + env)
        ├── .env                        # API keys (chmod 600)
        └── models/                     # optional volume for downloaded models
```

## Start the gateway

```bash
brick serve
```

This pulls `ghcr.io/regolo-ai/brick:latest` if missing, then runs `docker compose up -d`. The CLI waits up to 90s for `GET /health` on `localhost:18000` (default port from your profile).

Check state:

```bash
brick status            # active profile + running profile + container state
brick logs              # tail container logs
```

## Use it

```bash
# Interactive TUI chat (bottom input, scrolling history, Claude Code-style)
brick chat

# One-shot completion
brick generate "What's the capital of Lombardy?"

# Routing decision only (no generation)
brick route "compute eigenvalues of [[2,1],[1,3]]" --no-generate --json

# Repeated routing to compare latency
brick route "hello" --repeat 5
```

Useful flags:
- `--profile <name>`: pin a non-active profile for one command.
- `--thinking off|low|med|high|auto`: request reasoning effort (`X-Brick-Thinking` header).
- `--json`: machine-readable output.

## Manage profiles and configuration

```bash
brick config list             # all profiles
brick config use <name>       # switch active
brick config edit             # $EDITOR on config.yaml of active profile
brick config new <name>       # create a fresh profile
brick config remove <name>    # delete

brick add provider <name>     # interactive add to current profile
brick add model <id>
brick remove model <id>
```

## Stop / clean up

```bash
brick stop                    # docker compose stop (container kept)
brick down                    # docker compose down (container removed)
```

## Use a custom Docker image

Set `BRICK_IMAGE` env var to override the default:

```bash
export BRICK_IMAGE=ghcr.io/regolo-ai/brick:2.0.0
brick serve
```

## Anthropic passthrough (optional, for Claude Code integration)

The router exposes an Anthropic-compatible `/v1/messages` endpoint that proxies to the Brick virtual model. Useful for tools that expect Anthropic API (e.g. Claude Code):

```bash
export ANTHROPIC_BASE_URL=http://localhost:18000
export ANTHROPIC_API_KEY=$REGOLO_API_KEY
claude   # Claude Code now talks to Brick
brick claude status   # show wiring + recent routing stats
```

## Next

- Reproduce the paper: [eval.md](eval.md).
- Quickest path without install: [quick.md](quick.md).
- Router architecture details: [apps/router/README.md](../../apps/router/README.md).
