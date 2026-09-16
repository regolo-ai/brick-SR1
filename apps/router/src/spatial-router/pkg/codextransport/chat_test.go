package codextransport

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestChatToolCycle(t *testing.T) {
	input := `{"model":"m","instructions":"rules","input":[{"role":"developer","content":"keep"},{"role":"user","content":"run both"},{"type":"function_call","call_id":"a","name":"one","arguments":"{\"x\":1}"},{"type":"function_call","call_id":"b","name":"two","arguments":"{}"},{"type":"function_call_output","call_id":"a","output":"first"},{"type":"function_call_output","call_id":"b","output":"second"}],"tools":[{"type":"function","name":"one","parameters":{"type":"object"}},{"type":"function","name":"two","parameters":{"type":"object"}}]}`
	body, err := AdaptChat([]byte(input))
	if err != nil {
		t.Fatal(err)
	}
	var request map[string]any
	json.Unmarshal(body, &request)
	messages := request["messages"].([]any)
	if len(messages) != 5 {
		t.Fatal(string(body))
	}
	calls := messages[2].(map[string]any)["tool_calls"].([]any)
	if len(calls) != 2 || calls[0].(map[string]any)["id"] != "a" {
		t.Fatal(string(body))
	}
	for _, bad := range []string{`{"model":"m","input":"x","previous_response_id":"old"}`, `{"input":"x","tools":[{"type":"web_search"}]}`, `{"input":"x","include":["message.output_text.logprobs"]}`} {
		if _, err := AdaptChat([]byte(bad)); err == nil {
			t.Fatal("accepted incompatible request")
		}
	}
}
func TestChatStreamingTools(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer external" || r.Header.Get("X-Brick-Key") != "" {
			t.Error("credential leak")
		}
		io.WriteString(w, "data: "+`{"id":"chat1","choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_a","type":"function","function":{"name":"shell","arguments":"{"}}]},"finish_reason":null}]}`+"\n\n")
		io.WriteString(w, "data: "+`{"id":"chat1","choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"}"}}]},"finish_reason":"tool_calls"}]}`+"\n\ndata: [DONE]\n\n")
	}))
	defer upstream.Close()
	rec := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/", nil)
	req.Header.Set("Authorization", "Bearer codex")
	req.Header.Set("X-Brick-Key", "local")
	adapted, err := PrepareChat([]byte(`{"model":"m","input":"x","stream":true,"tools":[{"type":"function","name":"shell","parameters":{"type":"object"}}]}`))
	if err != nil {
		t.Fatal(err)
	}
	ForwardChat(rec, req, upstream.Client(), upstream.URL, "external", "external", adapted)
	if !strings.Contains(rec.Body.String(), "response.function_call_arguments.delta") || !strings.Contains(rec.Body.String(), "response.completed") {
		t.Fatal(rec.Body.String())
	}
	lines := strings.Split(rec.Body.String(), "\n")
	var item map[string]any
	for _, line := range lines {
		if strings.HasPrefix(line, "data: ") {
			var e map[string]any
			json.Unmarshal([]byte(strings.TrimPrefix(line, "data: ")), &e)
			if e["type"] == "response.completed" {
				item = e["response"].(map[string]any)["output"].([]any)[0].(map[string]any)
			}
		}
	}
	body, _ := json.Marshal(map[string]any{"input": []any{item}, "tools": []any{map[string]any{"type": "function", "name": "shell", "parameters": map[string]any{"type": "object"}}}})
	if _, err := AdaptChat(body); err != nil {
		t.Fatal("cannot replay own tool call", err, string(body))
	}
}
func TestChatNeverCompletesFailedStream(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, "data: {\"choices\":[{\"delta\":{\"content\":\"partial\"}}]}\n\n")
	}))
	defer upstream.Close()
	rec := httptest.NewRecorder()
	adapted, err := PrepareChat([]byte(`{"model":"m","input":"x","stream":true}`))
	if err != nil {
		t.Fatal(err)
	}
	ForwardChat(rec, httptest.NewRequest("POST", "/", nil), upstream.Client(), upstream.URL, "external", "key", adapted)
	if strings.Contains(rec.Body.String(), "response.completed") || !strings.Contains(rec.Body.String(), "response.failed") {
		t.Fatal(rec.Body.String())
	}
}

func TestCustomToolNamespaceRoundTrip(t *testing.T) {
	request := []byte(`{"model":"m","input":[{"type":"additional_tools","tools":[{"type":"namespace","name":"functions","tools":[{"type":"custom","name":"exec","description":"Run code","format":{"type":"grammar","syntax":"lark","definition":"start: WORD"}},{"type":"function","name":"wait","parameters":{"type":"object"}}]}]},{"role":"user","content":"run"}],"tools":[],"store":false,"metadata":{"session":"sanitized"},"reasoning":{"effort":"medium","summary":"auto"}}`)
	adapted, err := PrepareChat(request)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(adapted.Body), `functions__exec`) || !strings.Contains(string(adapted.Body), `Required format`) || strings.Contains(string(adapted.Body), `"grammar"`) && strings.Contains(string(adapted.Body), `response_format`) {
		t.Fatal(string(adapted.Body))
	}
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, `{"id":"chat_custom","choices":[{"message":{"role":"assistant","tool_calls":[{"index":0,"type":"function","function":{"name":"functions__exec","arguments":"{\"input\":\"text(\\\"测试\\n\\\");\"}"}}]},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":20,"prompt_tokens_details":{"cached_tokens":8},"completion_tokens":4,"total_tokens":24}}`)
	}))
	defer upstream.Close()
	recorder := httptest.NewRecorder()
	ForwardChat(recorder, httptest.NewRequest("POST", "/", nil), upstream.Client(), upstream.URL, "regolo", "secret", adapted)
	if recorder.Code != http.StatusOK {
		t.Fatal(recorder.Code, recorder.Body.String())
	}
	var response map[string]any
	if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
		t.Fatal(err)
	}
	item := response["output"].([]any)[0].(map[string]any)
	if item["type"] != "custom_tool_call" || item["name"] != "exec" || item["namespace"] != "functions" || item["input"] != "text(\"测试\n\");" {
		t.Fatal(recorder.Body.String())
	}
	usage := response["usage"].(map[string]any)
	if usage["input_tokens_details"].(map[string]any)["cached_tokens"] != float64(8) {
		t.Fatal(recorder.Body.String())
	}
}

func TestToolCollisionMissingIDAndStrictCustomContainer(t *testing.T) {
	for _, request := range []string{
		`{"input":"x","tools":[{"type":"function","name":"a__run"},{"type":"namespace","name":"a","tools":[{"type":"custom","name":"run"}]}]}`,
		`{"input":"x","tools":[{"type":"namespace","name":"a","tools":[{"type":"custom","name":"run"}]},{"type":"namespace","name":"b","tools":[{"type":"custom","name":"run"}]}],"tool_choice":{"type":"custom","name":"run"}}`,
	} {
		if _, err := PrepareChat([]byte(request)); err == nil {
			t.Fatal("accepted ambiguous tools", request)
		}
	}

	request := []byte(`{"model":"m","input":"x","tools":[{"type":"custom","name":"patch"}]}`)
	adapted, err := PrepareChat(request)
	if err != nil {
		t.Fatal(err)
	}
	serve := func(arguments string) *httptest.ResponseRecorder {
		upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			fmt.Fprintf(w, `{"id":"same","choices":[{"message":{"tool_calls":[{"type":"function","function":{"name":"patch","arguments":%q}}]},"finish_reason":"tool_calls"}]}`, arguments)
		}))
		defer upstream.Close()
		recorder := httptest.NewRecorder()
		ForwardChat(recorder, httptest.NewRequest("POST", "/", nil), upstream.Client(), upstream.URL, "p", "k", adapted)
		return recorder
	}
	first := serve(`{"input":"*** Begin Patch"}`)
	second := serve(`{"input":"*** Begin Patch"}`)
	if first.Code != 200 || first.Body.String() != second.Body.String() || !strings.Contains(first.Body.String(), `"call_id":"call_`) {
		t.Fatal(first.Code, first.Body.String(), second.Body.String())
	}
	invalid := serve(`{"input":"x","extra":true}`)
	if invalid.Code != 502 {
		t.Fatal("accepted invalid custom container", invalid.Code, invalid.Body.String())
	}
}

func TestIncompleteStreamIsNotCompleted(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, "data: "+`{"id":"c","choices":[{"delta":{"content":"partial"},"finish_reason":"length"}]}`+"\n\ndata: [DONE]\n\n")
	}))
	defer upstream.Close()
	adapted, _ := PrepareChat([]byte(`{"model":"m","input":"x","stream":true}`))
	recorder := httptest.NewRecorder()
	ForwardChat(recorder, httptest.NewRequest("POST", "/", nil), upstream.Client(), upstream.URL, "p", "k", adapted)
	if !strings.Contains(recorder.Body.String(), "response.incomplete") || strings.Contains(recorder.Body.String(), "response.completed") {
		t.Fatal(recorder.Body.String())
	}
}
