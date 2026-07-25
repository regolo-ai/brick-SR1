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
