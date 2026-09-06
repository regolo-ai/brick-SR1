# Regolo server deployment

`docker-compose/docker-compose.regolo.yml` deploys Brick with the accompanying
`config.regolo.yaml`. Inference and the hosted complexity classifier use Regolo.
The inference pool contains exactly `qwen3.5-9b`, `qwen3.5-122b`, and
`glm5.2`; Anthropic pass-through is disabled. These IDs are listed by the
[Regolo model catalog](https://docs.regolo.ai/models/catalog/).
Clients select `brick-v1-beta`; the legacy `brick` alias is also accepted.

Each caller supplies their Regolo API key as `Authorization: Bearer <user-key>`
to Brick. Brick forwards that same credential to Regolo for inference,
classification, and Regolo multimodal preprocessing. A missing or invalid client
credential is rejected; a server environment key never replaces it.
Classifier credentials are scoped to each request, including concurrent users.

Start the image containing these changes with a tested version. `BRICK_TAG` is
required so Compose cannot silently deploy an unrelated `latest` image:

```bash
cd deploy/docker-compose
BRICK_TAG='<version>' docker compose -f docker-compose.regolo.yml up -d
```

Neither Compose nor Kubernetes needs a server-side `REGOLO_API_KEY` or a Regolo
Secret. For Kubernetes, mount `docker-compose/config.regolo.yaml` as the router
configuration in the existing Deployment. Both classifier configuration blocks
use `use_client_key: true`; no static bearer token is configured.

The service listens on port `8000` by default (`BRICK_HOST_PORT` overrides it).
Keep `BRICK_TAG` set for subsequent Compose commands. Check a rollout with
`docker compose -f docker-compose.regolo.yml ps` and
`curl -fsS http://127.0.0.1:8000/health`. Classifier diagnostics require the caller's
Authorization header as well.

The container healthcheck uses Python, which is included in the runtime image.
A healthy process does not prove that a caller's key can access the upstream
models. Verify inference with an authorized Regolo key before accepting a rollout.

The deployment sets no output-token limit, and Brick does not add one to either
inference or complexity-classifier requests. Capability labels follow the
checkpoint's `id2label` order and are mapped into the router's capability order.
Rebuild the native Candle library together with the Go binary when updating
classification code; reusing an older library can change model selection.

The opt-in `TestRegoloLiveTrace` test exercises real classification and inference
with both JSON and streaming responses. It checks caller credentials, the native
probability distribution, label mapping, message preservation, model selection,
output-limit omission, response masking, and usage accounting. It requires
`BRICK_REGOLO_LIVE_API_KEY` and `BRICK_REGOLO_LIVE_CONFIG`; ordinary tests skip it.
Run its compiled test binary from the router root, with the capability checkpoint
under `models/` and the rebuilt native libraries on `LD_LIBRARY_PATH`.
