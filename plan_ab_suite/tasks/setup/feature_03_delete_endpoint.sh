#!/usr/bin/env bash
# Aggiunge il test TDD della feature: deve fallire finche DELETE non esiste.
set -eu
cat > feature_delete_test.go <<'GO'
package main

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestDeleteEndpoint(t *testing.T) {
	s := NewStore()
	if err := s.Add("t1", "a", "low"); err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(NewMux(s))
	defer srv.Close()

	req, err := http.NewRequest(http.MethodDelete, srv.URL+"/tasks/t1", nil)
	if err != nil {
		t.Fatal(err)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusNoContent {
		t.Fatalf("DELETE /tasks/t1: status = %d, want 204", resp.StatusCode)
	}

	got, err := http.Get(srv.URL + "/tasks/t1")
	if err != nil {
		t.Fatal(err)
	}
	got.Body.Close()
	if got.StatusCode != http.StatusNotFound {
		t.Fatalf("GET after delete: status = %d, want 404", got.StatusCode)
	}

	req2, err := http.NewRequest(http.MethodDelete, srv.URL+"/tasks/t1", nil)
	if err != nil {
		t.Fatal(err)
	}
	resp2, err := http.DefaultClient.Do(req2)
	if err != nil {
		t.Fatal(err)
	}
	resp2.Body.Close()
	if resp2.StatusCode != http.StatusNotFound {
		t.Fatalf("second DELETE: status = %d, want 404", resp2.StatusCode)
	}
}
GO
git add feature_delete_test.go && git commit -qm "test: describe DELETE /tasks/{id} feature"
if go test ./... >/dev/null 2>&1; then echo "setup error: tests still green" >&2; exit 1; fi
