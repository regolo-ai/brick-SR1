package main

import (
	"fmt"
	"strings"
	"testing"
)

func TestValidateID(t *testing.T) {
	for _, ok := range []string{"a1", "task-2", "x"} {
		if !ValidateID(ok) {
			t.Errorf("ValidateID(%q) = false, want true", ok)
		}
	}
	for _, bad := range []string{"", "a b", "a\tb"} {
		if ValidateID(bad) {
			t.Errorf("ValidateID(%q) = true, want false", bad)
		}
	}
}

func TestAddDuplicate(t *testing.T) {
	s := NewStore()
	if err := s.Add("t1", "first", "low"); err != nil {
		t.Fatalf("first add: %v", err)
	}
	if err := s.Add("t1", "again", "low"); err == nil {
		t.Fatal("duplicate add must fail")
	}
}

func TestListPagination(t *testing.T) {
	s := NewStore()
	for i := 1; i <= 12; i++ {
		if err := s.Add(fmt.Sprintf("t%02d", i), "task", "medium"); err != nil {
			t.Fatalf("add %d: %v", i, err)
		}
	}
	page1 := s.List(1)
	if len(page1) != DefaultPageSize || page1[0].ID != "t01" || page1[4].ID != "t05" {
		t.Fatalf("page 1 = %v, want t01..t05", ids(page1))
	}
	page2 := s.List(2)
	if len(page2) != DefaultPageSize || page2[0].ID != "t06" {
		t.Fatalf("page 2 = %v, want t06..t10", ids(page2))
	}
	page3 := s.List(3)
	if len(page3) != 2 || page3[0].ID != "t11" || page3[1].ID != "t12" {
		t.Fatalf("page 3 = %v, want t11 t12", ids(page3))
	}
	if got := s.List(4); got != nil {
		t.Fatalf("page 4 = %v, want empty", ids(got))
	}
}

func TestResetThenAdd(t *testing.T) {
	s := NewStore()
	if err := s.Add("t1", "first", "low"); err != nil {
		t.Fatalf("add: %v", err)
	}
	s.Reset()
	if got := s.All(); len(got) != 0 {
		t.Fatalf("after reset store must be empty, got %v", ids(got))
	}
	if err := s.Add("t2", "second", "high"); err != nil {
		t.Fatalf("add after reset: %v", err)
	}
}

func TestCompleteAndGet(t *testing.T) {
	s := NewStore()
	if err := s.Add("t1", "first", "low"); err != nil {
		t.Fatalf("add: %v", err)
	}
	if err := s.Complete("t1"); err != nil {
		t.Fatalf("complete: %v", err)
	}
	got, err := s.Get("t1")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if !got.Done {
		t.Fatal("completed task must be Done")
	}
	if _, err := s.Get("missing"); err == nil {
		t.Fatal("get of missing task must fail")
	}
}

func TestRenderOrder(t *testing.T) {
	tasks := []*Task{
		{ID: "lo", Title: "l", Priority: "low"},
		{ID: "hi", Title: "h", Priority: "high"},
		{ID: "mid", Title: "m", Priority: "medium"},
	}
	out := RenderTable(tasks)
	hi := strings.Index(out, "hi")
	mid := strings.Index(out, "mid")
	lo := strings.Index(out, "lo")
	if !(hi < mid && mid < lo) {
		t.Fatalf("render order must be high, medium, low:\n%s", out)
	}
}

func TestRenderDoneMarker(t *testing.T) {
	out := RenderTable([]*Task{{ID: "t1", Title: "x", Priority: "low", Done: true}})
	if !strings.Contains(out, "[x]") {
		t.Fatalf("done task must render an [x] marker:\n%s", out)
	}
	out = RenderTable([]*Task{{ID: "t2", Title: "y", Priority: "low"}})
	if strings.Contains(out, "[x]") {
		t.Fatalf("pending task must not render an [x] marker:\n%s", out)
	}
}

func ids(tasks []*Task) []string {
	out := make([]string, 0, len(tasks))
	for _, t := range tasks {
		out = append(out, t.ID)
	}
	return out
}
