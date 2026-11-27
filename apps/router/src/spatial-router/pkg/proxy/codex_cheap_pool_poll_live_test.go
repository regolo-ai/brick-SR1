package proxy

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/regolo-ai/brick-SR1/apps/router/src/spatial-router/pkg/brickrouting"
	"github.com/regolo-ai/brick-SR1/apps/router/src/spatial-router/pkg/config"
)

// poolPollTask is one bounded coding task with its own scratch workspace and a
// validation command that decides whether the routed model actually solved it.
type poolPollTask struct {
	Name      string
	Prompt    string
	Validate  string
	Files     map[string]string
	Protected []string
}

// TestCodexCheapPoolPollLive runs five serious coding tasks through the real
// Codex client, the real SystemOne router, and the production starter pool:
// gpt-5.6-luna (cheap tier) and gpt-5.6-terra (agentic tier), with the
// strong-agentic keyword rule. It logs which model served each task, whether
// the task's own tests pass afterwards, and how long each task took.
//
// Opt in with BRICK_CODEX_POOL_POLL_LIVE_TEST=1 (uses the ChatGPT subscription
// credentials already present in ~/.codex/auth.json).
func TestCodexCheapPoolPollLive(t *testing.T) {
	if os.Getenv("BRICK_CODEX_POOL_POLL_LIVE_TEST") != "1" {
		t.Skip("set BRICK_CODEX_POOL_POLL_LIVE_TEST=1 for the luna/terra five-task poll")
	}
	t.Setenv("BRICK_TEST_LOCAL", "local-cheap-poll")

	checkpoint, err := filepath.Abs("../../models/modernbert-capability-classifier")
	if err != nil {
		t.Fatal(err)
	}
	useReasoning := true
	cfg := &config.RouterConfig{CodexRouter: config.CodexRouterConfig{Enabled: true, LocalKeyEnv: "BRICK_TEST_LOCAL", TimeoutSeconds: 300}}
	cfg.ModelConfig = map[string]config.ModelParams{
		"luna-live":  {PreferredEndpoints: []string{"codex"}, UpstreamModel: "gpt-5.6-luna", ContextWindowSize: 272000, AllowedThinkingModes: []string{"low", "medium", "high", "xhigh"}},
		"terra-live": {PreferredEndpoints: []string{"codex"}, UpstreamModel: "gpt-5.6-terra", ContextWindowSize: 272000, AllowedThinkingModes: []string{"low", "medium", "high", "xhigh"}},
	}
	cfg.ProviderEndpoints = []config.ProviderEndpoint{{Name: "codex", ProviderProfileName: "openai-codex"}}
	cfg.ProviderProfiles = map[string]config.ProviderProfile{
		"openai-codex": {BaseURL: "https://chatgpt.com/backend-api/codex", Protocol: "responses", AuthSource: "codex_request", ResponsesPath: "responses", Capabilities: []string{"function_tools", "custom_tools", "opaque_reasoning", "images", "audio", "files", "item:additional_tools", "item:namespace"}},
	}
	cfg.SkillRouter = config.SkillRouterConfig{
		Enabled:      true,
		Capabilities: []string{"instruction_following", "coding", "math_reasoning", "world_knowledge", "planning_agentic", "creative_synthesis"},
		Models: []config.SkillRouterModelConfig{
			{Model: "luna-live", SkillVector: []float64{0.25, 0.56, 0.67, 0.57, 0.57, 0.57}, ModelReasoningControl: config.ModelReasoningControl{UseReasoning: &useReasoning}},
			{Model: "terra-live", SkillVector: []float64{0.80, 0.85, 0.88, 0.88, 0.86, 0.85}, ModelReasoningControl: config.ModelReasoningControl{UseReasoning: &useReasoning}},
		},
		ActiveModels: []string{"luna-live", "terra-live"},
		Keywords: []config.SkillRouterKeywordRuleConfig{
			{Name: "strong-agentic", Model: "terra-live", Keywords: []string{"apply_patch", "refactor", "debug", "bug", "bugs", "failing test", "failing tests", "unit test", "unit tests"}},
		},
		SystemOne: config.SystemOneConfig{LocalPath: checkpoint},
	}

	router, err := brickrouting.New(cfg)
	if err != nil {
		t.Fatalf("initialize SystemOne router: %v", err)
	}
	s := &Server{cfg: cfg, brickRouter: router}

	var mu sync.Mutex
	observations := []cheapMixObservation{}
	local := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requestBody, _ := io.ReadAll(r.Body)
		r.Body = io.NopCloser(bytes.NewReader(requestBody))
		capture := &cheapMixCaptureWriter{ResponseWriter: w}
		s.handleResponses(capture, r)
		mu.Lock()
		observations = append(observations, cheapMixObservation{
			Model:              capture.Header().Get("X-Brick-Selected-Model"),
			ReasoningRequested: capture.Header().Get("X-Brick-Reasoning-Requested"),
			ReasoningSent:      capture.Header().Get("X-Brick-Reasoning-Sent"),
			Status:             capture.status,
		})
		mu.Unlock()
	}))
	defer local.Close()

	catalogDir := t.TempDir()
	catalog := writeCheapMixCatalog(t, catalogDir)
	provider := fmt.Sprintf(`model_providers.brick={name="Brick cheap poll",base_url=%q,wire_api="responses",requires_openai_auth=true,supports_websockets=false,http_headers={"X-Brick-Key"="local-cheap-poll"},request_max_retries=0,stream_max_retries=0}`, local.URL+"/v1")

	effort := strings.TrimSpace(os.Getenv("BRICK_CODEX_POOL_EFFORT"))
	if effort == "" {
		effort = "medium"
	}
	tasks := cheapPoolTasks()
	results := make([]string, 0, len(tasks))
	sawLuna, sawTerra := false, false
	for index, task := range tasks {
		dir := t.TempDir()
		for name, content := range task.Files {
			path := filepath.Join(dir, name)
			if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(path, []byte(content), 0600); err != nil {
				t.Fatal(err)
			}
		}

		mu.Lock()
		observations = nil
		mu.Unlock()

		started := time.Now()
		taskCtx, cancel := context.WithTimeout(context.Background(), 6*time.Minute)
		cmd := exec.CommandContext(taskCtx, "codex", "exec", "--ignore-user-config", "--ephemeral", "--skip-git-repo-check", "--sandbox", "workspace-write", "-C", dir, "-m", "brick", "-c", `model_provider="brick"`, "-c", fmt.Sprintf(`model_reasoning_effort=%q`, effort), "-c", fmt.Sprintf("model_catalog_json=%q", catalog), "-c", provider, task.Prompt)
		output, runErr := cmd.CombinedOutput()
		cancel()
		duration := time.Since(started)

		verdict := "PASS"
		verifyCtx, verifyCancel := context.WithTimeout(context.Background(), 90*time.Second)
		verify := exec.CommandContext(verifyCtx, "sh", "-c", task.Validate)
		verify.Dir = dir
		verifyOut, verifyErr := verify.CombinedOutput()
		verifyCancel()
		if verifyErr != nil || runErr != nil {
			verdict = "FAIL"
		}
		for _, name := range task.Protected {
			current, readErr := os.ReadFile(filepath.Join(dir, name))
			if readErr != nil || string(current) != task.Files[name] {
				verdict = "FAIL"
				t.Logf("task %d edited protected file %s", index+1, name)
			}
		}

		mu.Lock()
		taskObservations := append([]cheapMixObservation(nil), observations...)
		mu.Unlock()
		models := make([]string, 0, len(taskObservations))
		for _, observation := range taskObservations {
			models = append(models, observation.Model)
			if observation.Model == "luna-live" {
				sawLuna = true
			}
			if observation.Model == "terra-live" {
				sawTerra = true
			}
		}
		line := fmt.Sprintf("task %d %-22s %s effort=%s %6.0fs models=[%s] validation=%q", index+1, task.Name, verdict, effort, duration.Seconds(), strings.Join(models, ","), tailLines(string(verifyOut), 3))
		t.Logf("%s", line)
		if runErr != nil {
			t.Logf("task %d codex error: %v\n%s", index+1, runErr, tailLines(string(output), 8))
		}
		results = append(results, line)
	}

	if !sawLuna || !sawTerra {
		t.Logf("note: this poll exercised luna=%v terra=%v; effort=%s", sawLuna, sawTerra, effort)
	}
	t.Logf("poll summary (effort=%s):\n%s", effort, strings.Join(results, "\n"))
}

func tailLines(value string, count int) string {
	lines := strings.Split(strings.TrimSpace(value), "\n")
	if len(lines) > count {
		lines = lines[len(lines)-count:]
	}
	return strings.Join(lines, " | ")
}

func cheapPoolTasks() []poolPollTask {
	return []poolPollTask{
		{
			Name:      "python-inventory-bug",
			Validate:  "python3 -m unittest -q test_inventory",
			Protected: []string{"test_inventory.py"},
			Prompt:    "The failing test suite test_inventory.py shows a bug: apply_discount mutates its input, does not reject percentages outside 0..100, and can round incorrectly. Fix inventory.py so every unit test passes. Do not edit test_inventory.py. Run python3 -m unittest -q test_inventory and report the result.",
			Files: map[string]string{
				"inventory.py": `def apply_discount(prices, pct):
    for index, price in enumerate(prices):
        prices[index] = round(price * (1 - pct / 100), 2)
    return prices
`,
				"test_inventory.py": `import unittest

from inventory import apply_discount


class ApplyDiscountTests(unittest.TestCase):
    def test_returns_new_list(self):
        prices = [10.0, 20.0]
        self.assertEqual(apply_discount(prices, 10), [9.0, 18.0])
        self.assertEqual(prices, [10.0, 20.0])

    def test_rounds_to_cents(self):
        self.assertEqual(apply_discount([9.99], 15), [8.49])

    def test_rejects_out_of_range(self):
        for pct in (-1, 101):
            with self.assertRaises(ValueError):
                apply_discount([1.0], pct)

    def test_empty(self):
        self.assertEqual(apply_discount([], 5), [])


if __name__ == "__main__":
    unittest.main()
`,
			},
		},
		{
			Name:      "go-interval-merge",
			Validate:  "go test ./...",
			Protected: []string{"merge_test.go"},
			Prompt:    "Implement Merge in merge.go using the unit tests in merge_test.go as the contract. Return an empty slice for no input, merge overlapping and adjacent intervals, and do not edit merge_test.go. Run go test ./... and report the result.",
			Files: map[string]string{
				"go.mod": `module example.com/intervals

go 1.22
`,
				"merge.go": `package intervals

// Merge combines overlapping or adjacent closed integer intervals.
func Merge(in [][2]int) [][2]int {
	return nil
}
`,
				"merge_test.go": `package intervals

import (
	"reflect"
	"testing"
)

func TestMerge(t *testing.T) {
	cases := []struct {
		name string
		in   [][2]int
		want [][2]int
	}{
		{"empty", nil, [][2]int{}},
		{"single", [][2]int{{1, 3}}, [][2]int{{1, 3}}},
		{"overlap", [][2]int{{1, 4}, {3, 6}}, [][2]int{{1, 6}}},
		{"adjacent", [][2]int{{1, 3}, {3, 6}}, [][2]int{{1, 6}}},
		{"unsorted", [][2]int{{8, 10}, {1, 4}, {3, 6}}, [][2]int{{1, 6}, {8, 10}}},
		{"negative", [][2]int{{-5, -1}, {-2, 2}}, [][2]int{{-5, 2}}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := Merge(tc.in)
			if !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("Merge(%v) = %v, want %v", tc.in, got, tc.want)
			}
		})
	}
}
`,
			},
		},
		{
			Name:      "python-topk",
			Validate:  "python3 -m unittest -q test_topk",
			Protected: []string{"test_topk.py"},
			Prompt:    "Implement top_k_frequent in topk.py so the checks in test_topk.py pass. Ties are ordered by first appearance, k<=0 returns an empty list, and k larger than the vocabulary returns every distinct word. Do not edit test_topk.py. Run python3 -m unittest -q test_topk and report the result.",
			Files: map[string]string{
				"topk.py": `def top_k_frequent(words, k):
    raise NotImplementedError
`,
				"test_topk.py": `import unittest

from topk import top_k_frequent


class TopKFrequentTests(unittest.TestCase):
    def test_orders_by_frequency(self):
        self.assertEqual(top_k_frequent(["a", "b", "a", "c", "b", "a"], 2), ["a", "b"])

    def test_ties_keep_first_appearance(self):
        self.assertEqual(top_k_frequent(["b", "a", "b", "a", "c"], 2), ["b", "a"])

    def test_bounds(self):
        self.assertEqual(top_k_frequent(["a"], 0), [])
        self.assertEqual(top_k_frequent(["a"], -3), [])
        self.assertEqual(top_k_frequent(["a", "b", "a"], 5), ["a", "b"])

    def test_empty(self):
        self.assertEqual(top_k_frequent([], 3), [])


if __name__ == "__main__":
    unittest.main()
`,
			},
		},
		{
			Name:      "node-daterange-bug",
			Validate:  "node --test",
			Protected: []string{"daterange.test.js"},
			Prompt:    "There is a bug in overlaps() in daterange.js: disjoint and touching ranges are reported as overlapping. Fix daterange.js so node --test passes. Do not edit daterange.test.js.",
			Files: map[string]string{
				"package.json": `{"type":"module"}
`,
				"daterange.js": `export function overlaps(a, b) {
  return a.start < b.end || b.start < a.end;
}
`,
				"daterange.test.js": `import test from 'node:test';
import assert from 'node:assert/strict';

import { overlaps } from './daterange.js';

test('overlapping ranges', () => {
  assert.equal(overlaps({ start: 0, end: 10 }, { start: 5, end: 15 }), true);
});
test('disjoint ranges', () => {
  assert.equal(overlaps({ start: 0, end: 5 }, { start: 6, end: 10 }), false);
});
test('touching ranges do not overlap', () => {
  assert.equal(overlaps({ start: 0, end: 5 }, { start: 5, end: 10 }), false);
});
test('contained range', () => {
  assert.equal(overlaps({ start: 0, end: 10 }, { start: 2, end: 3 }), true);
});
`,
			},
		},
		{
			Name:      "python-dedupe",
			Validate:  "python3 -m unittest -q test_dedupe",
			Protected: []string{"test_dedupe.py"},
			Prompt:    "Implement dedupe(items) in dedupe.py so the checks in test_dedupe.py pass: keep the first occurrence and preserve input order. Do not edit test_dedupe.py. Run python3 -m unittest -q test_dedupe and report the result.",
			Files: map[string]string{
				"dedupe.py": `def dedupe(items):
    return list(items)
`,
				"test_dedupe.py": `import unittest

from dedupe import dedupe


class DedupeTests(unittest.TestCase):
    def test_preserves_order(self):
        self.assertEqual(dedupe([1, 2, 1, 3, 2]), [1, 2, 3])

    def test_strings(self):
        self.assertEqual(dedupe(["a", "b", "a"]), ["a", "b"])

    def test_empty(self):
        self.assertEqual(dedupe([]), [])


if __name__ == "__main__":
    unittest.main()
`,
			},
		},
	}
}

// TestCheapPoolFixturesFailBeforeFix keeps the poll honest: every fixture must
// fail its validation before a model edits it, and every protected test file
// must exist exactly as declared.
func TestCheapPoolFixturesFailBeforeFix(t *testing.T) {
	for _, task := range cheapPoolTasks() {
		t.Run(task.Name, func(t *testing.T) {
			dir := t.TempDir()
			for name, content := range task.Files {
				path := filepath.Join(dir, name)
				if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(path, []byte(content), 0600); err != nil {
					t.Fatal(err)
				}
			}
			for _, name := range task.Protected {
				if _, ok := task.Files[name]; !ok {
					t.Fatalf("protected file %s is not part of the fixture", name)
				}
			}
			ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
			defer cancel()
			cmd := exec.CommandContext(ctx, "sh", "-c", task.Validate)
			cmd.Dir = dir
			if output, err := cmd.CombinedOutput(); err == nil {
				t.Fatalf("fixture %s already passes before the fix:\n%s", task.Name, output)
			}
		})
	}
}
