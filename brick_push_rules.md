# Brick branch and publish rules

## `main` — stable production

- Contains the stable, production-ready Brick code.
- Releases and production tags must point to commits contained in `main`.
- The `@regoloai/brick` npm package may be published **only from `main`**.

## `dev` — tested new features

- Contains new features that have been tested but are not yet considered safe
  for stable production.
- Changes move from `dev` to `main` only after production-readiness review.
- `dev` must never publish the npm package.

## `deploy` — Regolo inference configuration only

- Contains only the Regolo deployment configuration for running
  `brick-v1-beta` as an inference model on `regolo.ai`.
- Product features, CLI releases, and npm publishing do not belong here.
- `deploy` must never publish the npm package.
