#!/usr/bin/env bash
# Introduce il bug: off-by-one nell'indice di partenza della paginazione.
set -eu
sed -i 's/start := (page - 1) \* DefaultPageSize/start := (page-1)*DefaultPageSize + 1/' store.go
grep -q 'DefaultPageSize + 1' store.go
if go test ./... >/dev/null 2>&1; then echo "setup error: tests still green" >&2; exit 1; fi
