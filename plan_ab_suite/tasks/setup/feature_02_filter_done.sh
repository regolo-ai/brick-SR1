#!/usr/bin/env bash
# Aggiunge il test TDD della feature: deve fallire finche Filter non esiste.
set -eu
cat > feature_filter_test.go <<'GO'
package main

import "testing"

func TestFilterDone(t *testing.T) {
	s := NewStore()
	if err := s.Add("t1", "a", "low"); err != nil {
		t.Fatal(err)
	}
	if err := s.Add("t2", "b", "low"); err != nil {
		t.Fatal(err)
	}
	if err := s.Complete("t2"); err != nil {
		t.Fatal(err)
	}
	done := s.Filter(true)
	if len(done) != 1 || done[0].ID != "t2" {
		t.Fatalf("Filter(true) = %+v, want only t2", done)
	}
	pending := s.Filter(false)
	if len(pending) != 1 || pending[0].ID != "t1" {
		t.Fatalf("Filter(false) = %+v, want only t1", pending)
	}
}
GO
git add feature_filter_test.go && git commit -qm "test: describe Store.Filter feature"
if go test ./... >/dev/null 2>&1; then echo "setup error: tests still green" >&2; exit 1; fi
