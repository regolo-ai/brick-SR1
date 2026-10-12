package systemone

import (
	"bytes"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

func TestWorkerHelper(t *testing.T) {
	mode := os.Getenv("BRICK_WORKER_TEST")
	if mode == "" {
		return
	}
	switch mode {
	case "ready":
		_, _ = os.Stdout.WriteString("{\"ready\":true}\n")
		var data [1024]byte
		_, _ = os.Stdin.Read(data[:])
		_, _ = os.Stdout.WriteString("{\"probabilities\":[0,0.2,0.4,0.6,0.8,1]}\n")
	case "error":
		_, _ = os.Stdout.WriteString("{\"error\":\"model unavailable\"}\n")
	case "corrupt":
		_, _ = os.Stdout.WriteString("invalid json\n")
	}
	os.Exit(0)
}

func helper(mode string) *exec.Cmd {
	command := exec.Command(os.Args[0], "-test.run=^TestWorkerHelper$")
	command.Env = append(os.Environ(), "BRICK_WORKER_TEST="+mode)
	return command
}

func TestWorkerProtocolAndFailures(t *testing.T) {
	for _, mode := range []string{"error", "corrupt"} {
		if worker, err := startWorker(helper(mode)); err == nil {
			worker.close()
			t.Fatal("accepted invalid worker", mode)
		}
	}
	worker, err := startWorker(helper("ready"))
	if err != nil {
		t.Fatal(err)
	}
	defer worker.close()
	modelState.Lock()
	modelState.worker = worker
	modelState.path = "test"
	modelState.Unlock()
	defer func() { modelState.Lock(); modelState.worker = nil; modelState.path = ""; modelState.Unlock() }()
	result, err := Classify("hello")
	if err != nil || len(result) != 6 || result[5] != 1 {
		t.Fatal(result, err)
	}
	if _, err := Classify("bad\x00text"); err == nil {
		t.Fatal("accepted NUL")
	}
}

func TestPinnedManifestAndInvalidLocalAssets(t *testing.T) {
	cli, err := os.ReadFile("../../cli/assets/systemone.json")
	if err != nil || !bytes.Equal(cli, manifestJSON) {
		t.Fatal("CLI and runtime checkpoint manifests diverged", err)
	}
	dir := t.TempDir()
	if err := VerifyAssets(dir); err == nil {
		t.Fatal("accepted missing assets")
	}
	_ = os.WriteFile(filepath.Join(dir, "config.json"), []byte("{}"), 0600)
	if err := VerifyAssets(dir); err == nil {
		t.Fatal("accepted incompatible checkpoint")
	}
}
