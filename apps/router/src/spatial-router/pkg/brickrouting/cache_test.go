package brickrouting

import (
	"context"
	"strings"
	"sync"
	"testing"
	"time"
	"unicode/utf8"
)

func testRouter(classify func(context.Context, string) ([]float64, error)) *Router {
	return &Router{
		cache:    newVectorCache(vectorCacheEntries, vectorCacheTTL),
		classify: classify,
	}
}

func TestQueryVectorReusesRecentResult(t *testing.T) {
	calls := 0
	router := testRouter(func(context.Context, string) ([]float64, error) {
		calls++
		return []float64{.1, .2, .3, .4, .5, .6}, nil
	})
	for i := 0; i < 3; i++ {
		vector, err := router.queryVector(context.Background(), "ciao")
		if err != nil || len(vector) != 6 || vector[5] != .6 {
			t.Fatal(vector, err)
		}
	}
	if calls != 1 {
		t.Fatalf("identical text should classify once, got %d calls", calls)
	}
	vector, err := router.queryVector(context.Background(), "another prompt")
	if err != nil || len(vector) != 6 {
		t.Fatal(vector, err)
	}
	if calls != 2 {
		t.Fatalf("new text must classify, got %d calls", calls)
	}
}

func TestQueryVectorCollapsesConcurrentDuplicates(t *testing.T) {
	var mutex sync.Mutex
	calls := 0
	router := testRouter(func(context.Context, string) ([]float64, error) {
		mutex.Lock()
		calls++
		mutex.Unlock()
		time.Sleep(50 * time.Millisecond)
		return []float64{0, 0, 0, 0, 0, 1}, nil
	})
	var group sync.WaitGroup
	for i := 0; i < 8; i++ {
		group.Add(1)
		go func() {
			defer group.Done()
			if _, err := router.queryVector(context.Background(), "same prompt"); err != nil {
				t.Error(err)
			}
		}()
	}
	group.Wait()
	if calls != 1 {
		t.Fatalf("concurrent duplicates should share one inference, got %d", calls)
	}
}

func TestQueryVectorDoesNotCacheFailures(t *testing.T) {
	calls := 0
	router := testRouter(func(context.Context, string) ([]float64, error) {
		calls++
		if calls == 1 {
			return nil, context.DeadlineExceeded
		}
		return []float64{0, 0, 0, 0, 0, 1}, nil
	})
	if _, err := router.queryVector(context.Background(), "text"); err == nil {
		t.Fatal("expected the first inference to fail")
	}
	if _, err := router.queryVector(context.Background(), "text"); err != nil {
		t.Fatalf("a failure must not be cached: %v", err)
	}
	if calls != 2 {
		t.Fatalf("expected a retry, got %d calls", calls)
	}
}

func TestTrimRoutingTextKeepsTailAndRunes(t *testing.T) {
	if got := trimRoutingText("short", 8192); got != "short" {
		t.Fatalf("short text must pass through, got %q", got)
	}
	text := "abcdef" + "èèè"
	got := trimRoutingText(text, 6)
	if len(got) > 6 || got != "èèè" {
		t.Fatalf("unexpected tail slice %q", got)
	}
	if got := trimRoutingText(text, 7); len(got) > 7 || !utf8.ValidString(got) || !strings.HasSuffix(got, "èèè") {
		t.Fatalf("tail must stay valid UTF-8, got %q", got)
	}
}

func TestVectorCacheBoundsEntriesAndExpires(t *testing.T) {
	cache := newVectorCache(2, time.Minute)
	cache.put("a", []float64{1})
	cache.put("b", []float64{2})
	cache.put("c", []float64{3})
	if _, ok := cache.get("a"); ok {
		t.Fatal("oldest entry should be evicted")
	}
	if _, ok := cache.get("c"); !ok {
		t.Fatal("newest entry missing")
	}
	cache.now = func() time.Time { return time.Now().Add(2 * time.Minute) }
	if _, ok := cache.get("c"); ok {
		t.Fatal("expired entry must not be served")
	}
}
