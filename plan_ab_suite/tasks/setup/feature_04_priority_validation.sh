#!/usr/bin/env bash
# Aggiunge il test TDD della feature: deve fallire finche la validazione manca.
set -eu
cat > feature_priority_test.go <<'GO'
package main

import "testing"

func TestAddInvalidPriority(t *testing.T) {
	s := NewStore()
	if err := s.Add("t0", "a", "urgent"); err == nil {
		t.Fatal("Add with invalid priority must return an error")
	}
	for _, p := range []string{"low", "medium", "high"} {
		if err := s.Add("t_"+p, "a", p); err != nil {
			t.Fatalf("Add with valid priority %q rejected: %v", p, err)
		}
	}
}
GO
git add feature_priority_test.go && git commit -qm "test: describe priority validation feature"
if go test ./... >/dev/null 2>&1; then echo "setup error: tests still green" >&2; exit 1; fi
