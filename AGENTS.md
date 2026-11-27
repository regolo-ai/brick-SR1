# AGENTS — Contribution & Publication Rules

This file is the single source of truth for repository hygiene and publishing.
It supersedes and replaces `brick_push_rules.md` (removed).

## 1. Publication hygiene (MUST)

- **Never commit internal plans, notes, or development drafts.** This includes,
  but is not limited to: `plan_ab_suite/`, `plans/`, `*_plan*.md`, working
  documents, meeting notes, and research scratch files.
- Internal material belongs in your local workspace or an external tool
  (Notion, Google Docs), never in this repository.
- **All public content must be in English.** READMEs, docs, comments in
  published files, commit messages, and PR descriptions: English only.
- These patterns are blocked by `.gitignore`, a pre-commit hook
  (`no-internal-files`), and the CI `repo-hygiene` job. Do not try to work
  around them; if a legitimate file is falsely matched, update the allowlist
  in `scripts/check_no_internal_files.sh` in the same PR.

## 2. Branch & publish rules

### `main` — stable production

- Contains the stable, production-ready Brick code.
- Releases and production tags must point to commits contained in `main`.
- The `@regoloai/brick` npm package may be published **only from `main`**.

### `dev` — tested new features

- Contains new features that have been tested but are not yet considered safe
  for stable production.
- Changes move from `dev` to `main` only after production-readiness review.
- `dev` must never publish the npm package.

### `deploy` — Regolo inference configuration only

- Contains only the Regolo deployment configuration for running
  `brick-v1-beta` as an inference model on `regolo.ai`.
- Product features, CLI releases, and npm publishing do not belong here.
- `deploy` must never publish the npm package.

## 3. Workflow

```bash
make install   # deps for CLI + Python workspaces
make test      # Go + pytest + vitest, run before opening a PR
make lint      # pre-commit run --all-files
```

Branch from `main`, keep commits focused, follow the existing style of the
files you touch.

## 4. Enforcement

| Guard | Layer | What it blocks |
|---|---|---|
| `.gitignore` | local | internal plan paths are ignored by git |
| `no-internal-files` hook (`scripts/check_no_internal_files.sh`) | pre-commit | staging/committing internal plans or removed rule files |
| `repo-hygiene` job | CI | any branch where internal plans are tracked |

CI is authoritative: it cannot be bypassed with `--no-verify`.
