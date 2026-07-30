#!/usr/bin/env bash
# Pass se la risposta contiene il fatto atteso.
set -u
grep -qE "(^|[^0-9])5([^0-9]|$)" "$OUT_FILE"
