#!/usr/bin/env bash
# Blocks staging/committing internal plans, dev notes, or removed rule files.
# See AGENTS.md section "Publication hygiene".
set -euo pipefail

BLOCKED_PATTERNS='(^|/)plan_ab_suite/|(^|/)plans/|(^|/)[^/]*_plan[^/]*\.md$|(^|/)\.brick-internal/'
DENYLIST_FILES='^brick_push_rules\.md$'

failed=0

# 1. Staged files (pre-commit path): check the index diff.
if staged=$(git diff --cached --name-only --diff-filter=ACMR 2>/dev/null); then
  blocked=$(printf '%s\n' "$staged" | grep -E "$BLOCKED_PATTERNS" || true)
  denied=$(printf '%s\n' "$staged" | grep -E "$DENYLIST_FILES" || true)
  if [ -n "$blocked" ] || [ -n "$denied" ]; then
    echo "ERROR: internal files must not be committed (see AGENTS.md section 1):" >&2
    [ -n "$blocked" ] && printf '  %s\n' "$blocked" >&2
    [ -n "$denied" ] && printf '  %s\n' "$denied" >&2
    failed=1
  fi
fi

# 2. Explicit paths passed as arguments (CI / all-files mode).
if [ "$#" -gt 0 ]; then
  for f in "$@"; do
    if printf '%s\n' "$f" | grep -Eq "$BLOCKED_PATTERNS|$DENYLIST_FILES"; then
      echo "ERROR: forbidden file present: $f" >&2
      failed=1
    fi
  done
fi

if [ "$failed" -ne 0 ]; then
  echo "" >&2
  echo "Internal plans belong outside this repo. See AGENTS.md." >&2
  exit 1
fi

exit 0
