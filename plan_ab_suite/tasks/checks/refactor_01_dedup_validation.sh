#!/usr/bin/env bash
# Pass se i test sono verdi, la validazione esiste in un solo punto, gofmt pulito.
set -u
go test ./... || exit 1
[ "$(grep -c 'ContainsAny(id' store.go)" -le 1 ] || { echo "validation still duplicated"; exit 1; }
[ -z "$(gofmt -l .)" ] || { echo "gofmt dirty"; exit 1; }
