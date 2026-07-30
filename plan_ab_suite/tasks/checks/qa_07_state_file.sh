#!/usr/bin/env bash
# Pass se la risposta contiene il fatto atteso.
set -u
grep -qi "tasks\.json" "$OUT_FILE"
