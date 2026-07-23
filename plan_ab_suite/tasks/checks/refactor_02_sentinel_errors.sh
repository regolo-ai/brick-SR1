#!/usr/bin/env bash
# Pass se i test sono verdi e gli errori sentinella sostituiscono le stringhe inline.
set -u
go test ./... || exit 1
grep -q 'ErrInvalidID' store.go || { echo "ErrInvalidID missing"; exit 1; }
grep -q 'ErrNotFound' store.go || { echo "ErrNotFound missing"; exit 1; }
grep -q 'ErrDuplicate' store.go || { echo "ErrDuplicate missing"; exit 1; }
[ "$(grep -c 'fmt.Errorf("task not found")' store.go)" -eq 0 ] || { echo "inline error string still present"; exit 1; }
