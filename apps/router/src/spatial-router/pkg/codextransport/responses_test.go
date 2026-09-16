package codextransport

import (
	"bufio"
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestNativeStreamAndCredentialIsolation(t *testing.T) {
	release := make(chan struct{})
	received := make(chan string, 1)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer provider-secret" || r.Header.Get("X-Brick-Key") != "" || r.Header.Get("Chatgpt-Account-Id") != "" {
			t.Error("credential boundary violated")
		}
		body, _ := io.ReadAll(r.Body)
		received <- string(body)
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = io.WriteString(w, "event: response.created\ndata: {}\n\n")
		w.(http.Flusher).Flush()
		select {
		case <-release:
		case <-r.Context().Done():
			return
		}
		_, _ = io.WriteString(w, "event: response.completed\ndata: {}\n\n")
	}))
	defer upstream.Close()
	router := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		Forward(w, r, upstream.Client(), upstream.URL, "external", "provider-secret", false, body)
	}))
	defer router.Close()
	body := `{"model":"external","instructions":"preserve","input":[{"type":"function_call","call_id":"call_a","arguments":"{}","name":"shell"},{"type":"function_call_output","call_id":"call_a","output":"done"}],"tools":[{"type":"function","name":"shell","parameters":{"type":"object"}}]}`
	req, _ := http.NewRequest("POST", router.URL, strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer codex-secret")
	req.Header.Set("X-Brick-Key", "local-secret")
	req.Header.Set("Chatgpt-Account-Id", "account-secret")
	response, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	line, err := bufio.NewReader(response.Body).ReadString('\n')
	if err != nil || line != "event: response.created\n" {
		t.Fatalf("first event: %q %v", line, err)
	}
	if got := <-received; got != body {
		t.Fatal("structured request changed")
	}
	close(release)
}

func TestCancellation(t *testing.T) {
	cancelled := make(chan struct{})
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(200)
		w.(http.Flusher).Flush()
		<-r.Context().Done()
		close(cancelled)
	}))
	defer upstream.Close()
	router := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		Forward(w, r, upstream.Client(), upstream.URL, "external", "key", false, []byte(`{}`))
	}))
	defer router.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, "POST", router.URL, nil)
	response, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	cancel()
	response.Body.Close()
	select {
	case <-cancelled:
	case <-time.After(2 * time.Second):
		t.Fatal("upstream was not cancelled")
	}
}

func TestNoRedirectAndAuthAttribution(t *testing.T) {
	for _, codex := range []bool{false, true} {
		for _, status := range []int{401, 403, 307} {
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Location", "http://127.0.0.1:1/secret")
				w.Header().Set("WWW-Authenticate", "Bearer error=invalid_token")
				w.WriteHeader(status)
				io.WriteString(w, `{"error":"expired"}`)
			}))
			rec := httptest.NewRecorder()
			Forward(rec, httptest.NewRequest("POST", "/", nil), upstream.Client(), upstream.URL, "test", "secret", codex, []byte(`{}`))
			upstream.Close()
			want := 502
			if codex && status != 307 {
				want = status
			}
			if rec.Code != want {
				t.Fatalf("status %d, want %d", rec.Code, want)
			}
			if rec.Header().Get("Location") != "" {
				t.Fatal("redirect exposed")
			}
			if codex && status == 401 && rec.Header().Get("WWW-Authenticate") == "" {
				t.Fatal("lost auth recovery header")
			}
		}
	}
}

func TestCompatibilityAndRoutingView(t *testing.T) {
	body := []byte(`{"input":[{"type":"message","role":"developer","content":"rules"},{"type":"function_call_output","call_id":"a","output":"done"}],"tools":[{"type":"function","name":"shell","parameters":{"type":"object","properties":{"x":{"type":"unknown-schema-type"}}}}]}`)
	if Compatible(body, nil) == nil {
		t.Fatal("accepted unsupported tool cycle")
	}
	if err := Compatible(body, []string{"function_tools"}); err != nil {
		t.Fatal(err)
	}
	view := RoutingText(body, 1)
	if strings.Contains(view, "rules") || !strings.Contains(view, "done") {
		t.Fatal(view)
	}
	for _, body := range []string{`{"input":[{"type":"reasoning","encrypted_content":"opaque"}]}`, `{"input":[{"type":"custom_tool_call","input":"x"}]}`, `{"previous_response_id":"resp_old"}`, `{"input":[{"type":"new_unknown_item"}]}`} {
		if Compatible([]byte(body), []string{"function_tools"}) == nil {
			t.Fatal("accepted incompatible request", body)
		}
	}
}

func TestConcurrentSubscriptionRequests(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		if r.Header.Get("Authorization") != "Bearer "+string(body) || r.Header.Get("Chatgpt-Account-Id") != string(body) {
			t.Error("cross-session contamination")
		}
		io.WriteString(w, string(body))
	}))
	defer upstream.Close()
	done := make(chan bool, 2)
	for _, session := range []string{"session-one", "session-two"} {
		go func(session string) {
			r := httptest.NewRequest("POST", "/", nil)
			r.Header.Set("Chatgpt-Account-Id", session)
			w := httptest.NewRecorder()
			Forward(w, r, upstream.Client(), upstream.URL, "openai-codex", session, true, []byte(session))
			done <- w.Body.String() == session
		}(session)
	}
	if !<-done || !<-done {
		t.Fatal("session response mismatch")
	}
}
