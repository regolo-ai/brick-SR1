#!/usr/bin/env bash
# Pass se il progetto compila e tutti i test sono verdi.
set -u
go build ./... && go test ./...
