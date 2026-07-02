package economics

import (
	"os"
	"path/filepath"
	"reflect"
	"sync"
	"testing"
)

func TestStore_RecordUsage_Accumulates(t *testing.T) {
	s := NewStore()

	s.RecordUsage("claude-haiku", 100, 50)
	s.RecordUsage("claude-haiku", 200, 75)
	s.RecordUsage("claude-haiku", 10, 5)

	snap := s.Snapshot()
	if len(snap) != 1 {
		t.Fatalf("expected 1 entry, got %d", len(snap))
	}

	want := ModelUsage{
		Model:        "claude-haiku",
		Requests:     3,
		InputTokens:  310,
		OutputTokens: 130,
	}
	if snap[0] != want {
		t.Errorf("Snapshot()[0] = %+v, want %+v", snap[0], want)
	}
}

func TestStore_RecordUsage_MultipleModelsSorted(t *testing.T) {
	s := NewStore()

	s.RecordUsage("claude-sonnet", 100, 50)
	s.RecordUsage("claude-haiku", 20, 10)
	s.RecordUsage("claude-opus", 300, 150)

	snap := s.Snapshot()
	if len(snap) != 3 {
		t.Fatalf("expected 3 entries, got %d", len(snap))
	}

	wantOrder := []string{"claude-haiku", "claude-opus", "claude-sonnet"}
	for i, m := range wantOrder {
		if snap[i].Model != m {
			t.Errorf("Snapshot()[%d].Model = %q, want %q", i, snap[i].Model, m)
		}
	}
}

func TestStore_SaveAndLoadSnapshot_RoundTrip(t *testing.T) {
	s := NewStore()
	s.RecordUsage("claude-haiku", 100, 50)
	s.RecordUsage("claude-sonnet", 300, 150)
	s.RecordUsage("claude-haiku", 25, 10)

	dir := t.TempDir()
	path := filepath.Join(dir, "usage-snapshot.json")

	if err := s.SaveSnapshot(path); err != nil {
		t.Fatalf("SaveSnapshot returned error: %v", err)
	}

	if _, err := os.Stat(path); err != nil {
		t.Fatalf("expected snapshot file to exist: %v", err)
	}

	loaded := NewStore()
	if err := loaded.LoadSnapshot(path); err != nil {
		t.Fatalf("LoadSnapshot returned error: %v", err)
	}

	want := s.Snapshot()
	got := loaded.Snapshot()
	if !reflect.DeepEqual(want, got) {
		t.Errorf("round-tripped snapshot = %+v, want %+v", got, want)
	}
}

func TestStore_LoadSnapshot_MissingFileIsNotError(t *testing.T) {
	s := NewStore()
	err := s.LoadSnapshot("/nonexistent/dir/snapshot.json")
	if err != nil {
		t.Fatalf("expected no error for missing snapshot file, got: %v", err)
	}

	snap := s.Snapshot()
	if len(snap) != 0 {
		t.Errorf("expected empty store after loading missing file, got %d entries", len(snap))
	}
}

func TestStore_LoadSnapshot_MalformedFileIsError(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "bad.json")
	if err := os.WriteFile(path, []byte("not valid json {{{"), 0o644); err != nil {
		t.Fatalf("failed to write malformed file: %v", err)
	}

	s := NewStore()
	err := s.LoadSnapshot(path)
	if err == nil {
		t.Fatal("expected error for malformed snapshot file, got nil")
	}
}

func TestStore_RecordUsage_ConcurrentSameModel(t *testing.T) {
	s := NewStore()

	const goroutines = 50
	const perGoroutineInput = int64(7)
	const perGoroutineOutput = int64(3)

	var wg sync.WaitGroup
	wg.Add(goroutines)
	for i := 0; i < goroutines; i++ {
		go func() {
			defer wg.Done()
			s.RecordUsage("claude-haiku", perGoroutineInput, perGoroutineOutput)
		}()
	}
	wg.Wait()

	snap := s.Snapshot()
	if len(snap) != 1 {
		t.Fatalf("expected 1 entry, got %d", len(snap))
	}

	want := ModelUsage{
		Model:        "claude-haiku",
		Requests:     goroutines,
		InputTokens:  goroutines * perGoroutineInput,
		OutputTokens: goroutines * perGoroutineOutput,
	}
	if snap[0] != want {
		t.Errorf("Snapshot()[0] = %+v, want %+v", snap[0], want)
	}
}
