package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestPostEmptyBody(t *testing.T) {
	srv := httptest.NewServer(NewMux(NewStore()))
	defer srv.Close()
	resp, err := http.Post(srv.URL+"/tasks", "application/json", nil)
	if err != nil {
		t.Fatalf("post: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("POST /tasks with empty body: status = %d, want 400", resp.StatusCode)
	}
}

func TestPostThenGet(t *testing.T) {
	srv := httptest.NewServer(NewMux(NewStore()))
	defer srv.Close()
	body := strings.NewReader(`{"ID":"t1","Title":"hello","Priority":"high"}`)
	resp, err := http.Post(srv.URL+"/tasks", "application/json", body)
	if err != nil {
		t.Fatalf("post: %v", err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("POST /tasks: status = %d, want 201", resp.StatusCode)
	}
	got, err := http.Get(srv.URL + "/tasks/t1")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	defer got.Body.Close()
	if got.StatusCode != http.StatusOK {
		t.Fatalf("GET /tasks/t1: status = %d, want 200", got.StatusCode)
	}
}

func TestGetTaskNotFound(t *testing.T) {
	srv := httptest.NewServer(NewMux(NewStore()))
	defer srv.Close()
	resp, err := http.Get(srv.URL + "/tasks/nope")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("GET /tasks/nope: status = %d, want 404", resp.StatusCode)
	}
}

func TestListTasks(t *testing.T) {
	s := NewStore()
	if err := s.Add("t1", "hello", "low"); err != nil {
		t.Fatalf("add: %v", err)
	}
	srv := httptest.NewServer(NewMux(s))
	defer srv.Close()
	resp, err := http.Get(srv.URL + "/tasks")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("GET /tasks: status = %d, want 200", resp.StatusCode)
	}
	if ct := resp.Header.Get("Content-Type"); ct != "application/json" {
		t.Fatalf("content type = %q, want application/json", ct)
	}
}
