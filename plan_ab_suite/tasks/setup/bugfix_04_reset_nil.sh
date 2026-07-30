#!/usr/bin/env bash
# Introduce il bug: Reset lascia la mappa interna nil.
set -eu
sed -i 's/s.tasks, s.order = make(map\[string\]\*Task), nil/s.tasks, s.order = nil, nil/' store.go
grep -q 's.tasks, s.order = nil, nil' store.go
if go test ./... >/dev/null 2>&1; then echo "setup error: tests still green" >&2; exit 1; fi
