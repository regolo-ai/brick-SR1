#!/usr/bin/env bash
# Introduce il bug: comparatore di priorita invertito in format.go.
set -eu
sed -i 's/priorityRank\[out\[i\]\.Priority\] < priorityRank\[out\[j\]\.Priority\]/priorityRank[out[i].Priority] > priorityRank[out[j].Priority]/' format.go
grep -q 'priorityRank\[out\[i\]\.Priority\] > priorityRank\[out\[j\]\.Priority\]' format.go
if go test ./... >/dev/null 2>&1; then echo "setup error: tests still green" >&2; exit 1; fi
