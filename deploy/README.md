# Regolo server deployment

`docker-compose/docker-compose.regolo.yml` deploys Brick with the accompanying
`config.regolo.yaml`. It has one upstream only: `https://api.regolo.ai/v1`.
The model pool and the hosted complexity classifier are both served by Regolo;
the profile intentionally does not enable Anthropic pass-through.

On each server, set `REGOLO_API_KEY` through the normal secret manager or an
untracked environment file, then start the pinned image:

```bash
cd deploy/docker-compose
REGOLO_API_KEY='…' BRICK_TAG='v2.2.1' docker compose -f docker-compose.regolo.yml up -d
```

The service listens on port `8000` by default (`BRICK_HOST_PORT` overrides it).
Check a rollout with `docker compose -f docker-compose.regolo.yml ps` and
`curl -fsS http://127.0.0.1:8000/health`.

## Pollinations endpoint agent

`docker-compose/docker-compose.pollinations.yml` runs Brick as a Pollinations
endpoint agent. It routes among the Pollinations GPT-5.6 tiers and forwards the
short-lived `ag_` bearer supplied by Pollinations; the profile contains no
Pollinations API key.

Set only the local classifier token, then start the stack:

```bash
BRICK_CLASSIFIER_TOKEN='…' docker compose \
  -f docker-compose/docker-compose.pollinations.yml up -d
```

Publish the router behind HTTPS and register its public `/v1` URL with upstream
model `brick`. Direct calls made with other bearer-token types are rejected.
