package proxy

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// A provider can leave a keep-alive connection half-open after a stream cut.
// The upstream transport must turn that into a fast error (so the caller can
// retry on a fresh connection) instead of hanging forever.
func TestUpstreamTransportTimesOutWedgedUpstream(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Never write headers: simulate a half-open provider connection. The
		// bounded wait keeps the test teardown from waiting on a handler that
		// cannot observe the client disconnect.
		select {
		case <-r.Context().Done():
		case <-time.After(2 * time.Second):
		}
	}))
	defer server.Close()

	client := &http.Client{Transport: newUpstreamTransport(250 * time.Millisecond)}
	started := time.Now()
	resp, err := client.Post(server.URL, "application/json", strings.NewReader(`{}`))
	if err == nil {
		resp.Body.Close()
		t.Fatal("expected the wedged upstream to time out")
	}
	if elapsed := time.Since(started); elapsed > 5*time.Second {
		t.Fatalf("wedge detection took too long: %v", elapsed)
	}
}

func TestUpstreamTransportServesCooperativeUpstream(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("data: {\"ok\":true}\n\n"))
	}))
	defer server.Close()

	client := &http.Client{Transport: newUpstreamTransport(120 * time.Second)}
	resp, err := client.Post(server.URL, "application/json", strings.NewReader(`{}`))
	if err != nil {
		t.Fatalf("cooperative upstream failed: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("unexpected status %d", resp.StatusCode)
	}
}

func TestCodexUpstreamClientConfiguration(t *testing.T) {
	transport, ok := codexUpstreamClient.Transport.(*http.Transport)
	if !ok {
		t.Fatal("codex upstream client must use the hardened transport")
	}
	if !transport.DisableCompression {
		t.Fatal("SSE forwarding must disable transparent compression")
	}
	if transport.ResponseHeaderTimeout != upstreamHeaderTimeout {
		t.Fatalf("header timeout %v, want %v", transport.ResponseHeaderTimeout, upstreamHeaderTimeout)
	}
	if transport.IdleConnTimeout == 0 {
		t.Fatal("idle connections must be retired")
	}
}
