#!/usr/bin/env bash
# Pass se la risposta contiene il fatto atteso.
set -u
grep -q "400" "$OUT_FILE"
