#!/usr/bin/env bash
# Introduce il bug: l'errore empty body risponde 200 invece di 400.
set -eu
sed -i 's/"empty body", http.StatusBadRequest/"empty body", http.StatusOK/' server.go
grep -q '"empty body", http.StatusOK' server.go
if go test ./... >/dev/null 2>&1; then echo "setup error: tests still green" >&2; exit 1; fi
