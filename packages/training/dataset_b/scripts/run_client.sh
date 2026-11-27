#!/usr/bin/env bash
# Run a Dataset B script with the repository lockfile from any working directory.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
exec uv run --frozen --package brick-training python "$@"
