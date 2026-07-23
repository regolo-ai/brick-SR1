#!/usr/bin/env bash
# Pass se i test sono verdi e la CLI espone davvero list --json.
set -u
go test ./... || exit 1
rm -f tasks.json
go run . add t1 hello >/dev/null 2>&1 || exit 1
go run . list --json | python3 -c 'import json,sys; d=json.load(sys.stdin); assert any(x.get("ID")=="t1" for x in d)'
