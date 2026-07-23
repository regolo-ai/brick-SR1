#!/usr/bin/env bash
# Aggiunge il test TDD della feature: deve fallire finche RenderJSON non esiste.
set -eu
cat > feature_json_test.go <<'GO'
package main

import (
	"encoding/json"
	"testing"
)

func TestRenderJSON(t *testing.T) {
	tasks := []*Task{
		{ID: "a", Title: "x", Priority: "low"},
		{ID: "b", Title: "y", Priority: "high", Done: true},
	}
	out := RenderJSON(tasks)
	var got []Task
	if err := json.Unmarshal([]byte(out), &got); err != nil {
		t.Fatalf("RenderJSON must produce valid JSON: %v\n%s", err, out)
	}
	if len(got) != 2 || got[0].ID != "a" || !got[1].Done {
		t.Fatalf("RenderJSON round-trip mismatch: %+v", got)
	}
}
GO
git add feature_json_test.go && git commit -qm "test: describe RenderJSON feature"
if go test ./... >/dev/null 2>&1; then echo "setup error: tests still green" >&2; exit 1; fi
