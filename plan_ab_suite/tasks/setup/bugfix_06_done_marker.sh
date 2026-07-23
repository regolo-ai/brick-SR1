#!/usr/bin/env bash
# Introduce il bug: marcatore done invertito in format.go.
set -eu
sed -i 's/if t.Done {/if !t.Done {/' format.go
grep -q 'if !t.Done {' format.go
if go test ./... >/dev/null 2>&1; then echo "setup error: tests still green" >&2; exit 1; fi
