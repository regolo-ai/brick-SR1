#!/usr/bin/env bash
# Pass se la risposta contiene il fatto atteso.
set -u
grep -q "/tasks" "$OUT_FILE" && grep -qi "POST" "$OUT_FILE" && grep -qi "GET" "$OUT_FILE"
