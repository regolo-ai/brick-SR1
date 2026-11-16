# Brick 4.0.0 release notes

Brick 4.0 moves routing fully local: a pinned SystemOne checkpoint classifies
each query into a six-dimensional capability vector, and the gateway picks a
model from your own provider pool. There is no per-token routing fee and no
prompt retention by the router.

## Highlights

- **Local SystemOne routing**: a pinned, public Apache-2.0 checkpoint runs in a
  persistent Python worker on CPU (FP32) or CUDA (BF16, FlashAttention 2 when
  available). The Go gateway embeds the worker and talks to it over pipes.
- **One-command Codex setup**: `npm install -g @regoloai/brick`, then
  `codex login`, then `brick start codex`. Brick creates the managed profile,
  verifies the checkpoint installed by `npm install`, starts the router and
  wires the official Codex client. The default subscription pool is
  `gpt-6-luna` and `gpt-6.1-terra`; no Regolo API key is required.
- **Remote skill vectors**: the package no longer bundles a skill table. Setup
  and every start download `skill_vectors.csv` from the Hugging Face dataset
  `regolo/brick-skill-tables`, validate it and cache it under
  `$BRICK_HOME/cache`. `BRICK_SKILLS_OFFLINE=1` uses the cache without network.
  A failed or invalid download, or a model missing from the table, keeps the
  vector already configured instead of dropping the model from the pool.
- **Safer Codex migration**: existing profiles keep user-owned pools and
  routing rules. `brick start codex --reset-pool` resets only the active pool,
  default model and empty rule list, leaving providers and credentials alone.
  A metadata-only preflight warns when the authenticated Codex catalog does
  not list an active model.
- **CLI tooling**: `brick doctor`, `brick quickstart`, `brick explain`,
  `brick savings`, `brick models`, `brick skills audit`, `brick support` and
  shell completions.
- **Pricing refresh**: curated Anthropic rows (including `claude-fable`) and
  GPT-6.x OpenAI rows are explicit and regression-tested.

## Upgrade notes

- 4.0 keeps configuration-compatible with 3.x and migrates on first start. See
  `docs/migration-v4.md` for the 3.x to 4.0 steps and rollback path.
- The npm package ships a verified native runtime per platform; the SystemOne
  checkpoint is downloaded and checksum-verified by `postinstall`.
- npm publication requires the verified multi-platform runtime artifacts and
  the publish workflow run from `main`.
- The `ultra` reasoning level advertised by some Codex models is clamped to
  `max`: the subscription gateway only supports levels up to `max`.
- If the Hugging Face skill table lags a Codex catalog change, the resolver
  prefers exact rows, falls back to aliases/cached vectors and emits a drift
  warning rather than silently dropping models.

## Known limitations

- The 4.0 SystemOne router has not yet been benchmarked on Dataset A; historical
  paper numbers describe the previous router and are not claimed for 4.0.
- `claude-sonnet` pricing follows the live LiteLLM feed (currently 2/10 USD per
  1M input/output tokens); verify against your own provider invoice.
