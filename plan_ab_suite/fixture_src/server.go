package main

import (
	"encoding/json"
	"net/http"
	"strings"
)

// NewMux returns the HTTP API:
//
//	GET  /tasks       list all tasks as JSON
//	POST /tasks       create a task from a JSON body
//	GET  /tasks/{id}  fetch a single task
func NewMux(s *Store) *http.ServeMux {
	mux := http.NewServeMux()
	mux.HandleFunc("/tasks", func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet:
			writeJSON(w, s.All())
		case http.MethodPost:
			if r.ContentLength == 0 {
				http.Error(w, "empty body", http.StatusBadRequest)
				return
			}
			var in struct{ ID, Title, Priority string }
			if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
				http.Error(w, "bad json", http.StatusBadRequest)
				return
			}
			if err := s.Add(in.ID, in.Title, in.Priority); err != nil {
				http.Error(w, err.Error(), http.StatusBadRequest)
				return
			}
			w.WriteHeader(http.StatusCreated)
		default:
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		}
	})
	mux.HandleFunc("/tasks/", func(w http.ResponseWriter, r *http.Request) {
		id := strings.TrimPrefix(r.URL.Path, "/tasks/")
		if r.Method != http.MethodGet {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		t, err := s.Get(id)
		if err != nil {
			http.Error(w, err.Error(), http.StatusNotFound)
			return
		}
		writeJSON(w, t)
	})
	return mux
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(v)
}
