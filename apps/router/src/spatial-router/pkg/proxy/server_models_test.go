package proxy

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/regolo-ai/brick-SR1/apps/router/src/spatial-router/pkg/config"
)

func TestHandleModelsListsCodexBrickPool(t *testing.T) {
	cfg := &config.RouterConfig{}
	cfg.AutoModelName = "brick"
	cfg.IncludeConfigModelsInList = true
	cfg.SkillRouter.Models = []config.SkillRouterModelConfig{
		{Model: "gpt-5.6-luna"},
		{Model: "gpt-5.4-mini"},
	}
	s := &Server{cfg: cfg}
	r := httptest.NewRequest(http.MethodGet, "/v1/models", nil)
	w := httptest.NewRecorder()

	s.handleModels(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", w.Code)
	}
	var got struct {
		Data []struct {
			ID string `json:"id"`
		} `json:"data"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	ids := make(map[string]bool, len(got.Data))
	for _, model := range got.Data {
		ids[model.ID] = true
	}
	for _, want := range []string{"brick", "gpt-5.6-luna", "gpt-5.4-mini"} {
		if !ids[want] {
			t.Errorf("/v1/models missing %q: %#v", want, ids)
		}
	}
}

func TestHandleModelsKeepsClaudeListWithoutConfigPool(t *testing.T) {
	cfg := &config.RouterConfig{}
	cfg.AutoModelName = "brick"
	cfg.AnthropicPassthrough.Enabled = true
	cfg.SkillRouter.Models = []config.SkillRouterModelConfig{{Model: "gpt-5.4"}}
	s := &Server{cfg: cfg}
	r := httptest.NewRequest(http.MethodGet, "/v1/models", nil)
	w := httptest.NewRecorder()

	s.handleModels(w, r)
	var got struct {
		Data []struct {
			ID string `json:"id"`
		} `json:"data"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	ids := make(map[string]bool, len(got.Data))
	for _, model := range got.Data {
		ids[model.ID] = true
	}
	for _, want := range []string{"brick", "brick-claude", "claude-opus-4-8"} {
		if !ids[want] {
			t.Errorf("/v1/models missing %q: %#v", want, ids)
		}
	}
	if ids["gpt-5.4"] {
		t.Error("unexpected config model when include_config_models_in_list is false")
	}
}
