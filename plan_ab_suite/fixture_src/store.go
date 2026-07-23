package main

import (
	"fmt"
	"strings"
)

// DefaultPageSize is the number of tasks shown per page by the list command.
const DefaultPageSize = 5

// Task is one tracked item.
type Task struct {
	ID       string
	Title    string
	Priority string // low | medium | high
	Done     bool
}

// Store holds tasks in memory, keyed by ID, with insertion order preserved.
type Store struct {
	tasks map[string]*Task
	order []string
}

// NewStore returns an empty store.
func NewStore() *Store {
	return &Store{tasks: make(map[string]*Task)}
}

// ValidateID reports whether id is a legal task identifier: non-empty, with
// no spaces or tabs.
func ValidateID(id string) bool {
	return len(id) != 0 && !strings.ContainsAny(id, " \t")
}

// Add inserts a new task with the given priority.
func (s *Store) Add(id, title, priority string) error {
	if len(id) == 0 || strings.ContainsAny(id, " \t") {
		return fmt.Errorf("invalid task id")
	}
	if _, exists := s.tasks[id]; exists {
		return fmt.Errorf("task already exists")
	}
	s.tasks[id] = &Task{ID: id, Title: title, Priority: priority}
	s.order = append(s.order, id)
	return nil
}

// Complete marks the task with the given id as done.
func (s *Store) Complete(id string) error {
	if len(id) == 0 || strings.ContainsAny(id, " \t") {
		return fmt.Errorf("invalid task id")
	}
	t, ok := s.tasks[id]
	if !ok {
		return fmt.Errorf("task not found")
	}
	t.Done = true
	return nil
}

// Get returns the task with the given id.
func (s *Store) Get(id string) (*Task, error) {
	if len(id) == 0 || strings.ContainsAny(id, " \t") {
		return nil, fmt.Errorf("invalid task id")
	}
	t, ok := s.tasks[id]
	if !ok {
		return nil, fmt.Errorf("task not found")
	}
	return t, nil
}

// List returns one page of tasks in insertion order. Pages are 1-based and
// hold DefaultPageSize tasks each.
func (s *Store) List(page int) []*Task {
	if page < 1 {
		page = 1
	}
	start := (page - 1) * DefaultPageSize
	if start >= len(s.order) {
		return nil
	}
	end := start + DefaultPageSize
	if end > len(s.order) {
		end = len(s.order)
	}
	out := make([]*Task, 0, end-start)
	for _, id := range s.order[start:end] {
		out = append(out, s.tasks[id])
	}
	return out
}

// All returns every task in insertion order.
func (s *Store) All() []*Task {
	out := make([]*Task, 0, len(s.order))
	for _, id := range s.order {
		out = append(out, s.tasks[id])
	}
	return out
}

// Reset drops all tasks, leaving the store ready for reuse.
func (s *Store) Reset() {
	s.tasks, s.order = make(map[string]*Task), nil
}
