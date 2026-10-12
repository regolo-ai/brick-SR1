package brickrouting

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/regolo-ai/brick-SR1/apps/router/src/semantic-router/pkg/config"
)

// mock sidecar returning dims in scrambled order to verify name-based mapping.
func TestSystemoneClientMapsDimsByName(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/vectors" {
			t.Errorf("unexpected path %s", r.URL.Path)
		}
		json.NewEncoder(w).Encode(map[string]interface{}{
			"vectors": []float64{0.1, 0.9, 0.2},
			"dims":    []string{"coding", "planning_agentic", "world_knowledge"},
		})
	}))
	defer srv.Close()

	c := &systemoneClient{baseURL: srv.URL, httpClient: &http.Client{Timeout: 5 * time.Second}}
	v, dims, err := c.Vectors(context.Background(), "test")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(v) != 3 || dims[1] != "planning_agentic" {
		t.Fatalf("unexpected payload: %v %v", v, dims)
	}
}

func TestClassifySidecarNormalizesAndOrders(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]interface{}{
			"vectors": []float64{0.9, 0.1, 0.0},
			"dms":     nil,
			"dims":    []string{"coding", "world_knowledge", "planning_agentic"},
		})
	}))
	defer srv.Close()

	cc := &capabilityClassifier{
		labels:  []string{"world_knowledge", "coding", "planning_agentic"},
		sidecar: &systemoneClient{baseURL: srv.URL, httpClient: &http.Client{Timeout: 5 * time.Second}},
	}
	p, err := cc.classifySidecar("test")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	// world=0.1, coding=0.9, planning=0.0 normalized -> [0.1, 0.9, 0.0]
	if len(p) != 3 || p[0] < 0.099 || p[0] > 0.101 || p[1] < 0.899 || p[1] > 0.901 {
		t.Fatalf("bad mapping/normalize: %v", p)
	}
}

func TestClassifySidecarMissingDimErrors(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]interface{}{
			"vectors": []float64{0.5},
			"dims":    []string{"coding"},
		})
	}))
	defer srv.Close()

	cc := &capabilityClassifier{
		labels:  []string{"coding", "math_reasoning"},
		sidecar: &systemoneClient{baseURL: srv.URL, httpClient: &http.Client{Timeout: 5 * time.Second}},
	}
	if _, err := cc.classifySidecar("test"); err == nil {
		t.Fatal("expected missing-dim error")
	}
}

func TestSystemoneClientSendsBearerAndFailsOn500(t *testing.T) {
	var gotAuth string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer srv.Close()

	c := &systemoneClient{baseURL: srv.URL, bearerToken: "sekret",
		httpClient: &http.Client{Timeout: 5 * time.Second}}
	if _, _, err := c.Vectors(context.Background(), "x"); err == nil {
		t.Fatal("expected status error")
	}
	if gotAuth != "Bearer sekret" {
		t.Fatalf("bad auth header: %q", gotAuth)
	}
}

func TestNewSystemoneClientNilWithoutURL(t *testing.T) {
	if c := newSystemoneClient(config.SkillRouterCapabilityModelConfig{}); c != nil {
		t.Fatal("expected nil client without SidecarURL")
	}
	got := newSystemoneClient(config.SkillRouterCapabilityModelConfig{SidecarURL: "http://127.0.0.1:8095/"})
	if got == nil || got.baseURL != "http://127.0.0.1:8095" {
		t.Fatalf("bad client: %+v", got)
	}
}
