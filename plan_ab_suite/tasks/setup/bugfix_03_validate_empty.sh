#!/usr/bin/env bash
# Introduce il bug: ValidateID accetta la stringa vuota.
set -eu
sed -i 's/return len(id) != 0 \&\& !strings.ContainsAny/return len(id) >= 0 \&\& !strings.ContainsAny/' store.go
grep -q 'len(id) >= 0' store.go
if go test ./... >/dev/null 2>&1; then echo "setup error: tests still green" >&2; exit 1; fi
