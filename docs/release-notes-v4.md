# Brick 4.0.0 release notes

## Highlights

- **One-command Codex setup**: `npm install -g @regoloai/brick` + `codex login` + `brick start codex` creates the managed profile, verifies the installed SystemOne checkpoint, starts the local router, and wires the official Codex client. The default subscription pool is `gpt-6-luna` and `gpt-6.1-terra`.
- **Remote skill vectors**: the CLI no longer ships hardcoded skill tables. Profile setup and every `brick start` download `skill_vectors.csv` from `regolo/brick-skill-tables`, validate it, and cache it under `$BRICK_HOME/cache` (`BRICK_SKILLS_OFFLINE=1` uses the cache). Invalid downloads, offline runs, or missing rows keep the vectors already configured instead of dropping pool models.
- **Safer Codex migration**: existing Codex profiles keep user-owned pools and rules; `brick start codex --reset-pool` resets only the routing pool/default to the 6.x Codex pair. Startup warns (metadata-only) when an active model is absent from the authenticated Codex catalog.
- **Pricing refresh**: curated Anthropic rows (including `claude-fable`) and GPT-6.x OpenAI rows are kept explicit and regression-tested.

## Upgrade notes

- npm publication of 4.0.0 requires the verified multi-platform runtime artifacts and the publish workflow run from `main`.
- If the published Hugging Face skill table lags a Codex catalog change, the resolver prefers exact rows, falls back to aliases/cached vectors, and emits drift/missing-model warnings.
