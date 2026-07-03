// Package complexityserver supervises the external brick-complexity classifier
// process. When the configured /classify port is unreachable at startup, it
// pre-downloads the LoRA model from HuggingFace and spawns the Python server
// as a child process; on shutdown it sends SIGTERM and waits for exit.
package complexityserver

import (
	"fmt"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"syscall"
	"time"

	"github.com/regolo-ai/brick-SR1/apps/router/src/spatial-router/pkg/config"
	"github.com/regolo-ai/brick-SR1/apps/router/src/spatial-router/pkg/observability/logging"
)

// LoraRepo and BaseRepo are the HuggingFace repositories required by the
// brick-complexity-server (kept in sync with deploy/addons/brick-complexity-server/server.py).
const (
	LoraRepo = "regolo/brick-complexity-2-eco"
	BaseRepo = "Qwen/Qwen3.5-0.8B"
)

// Subprocess wraps a spawned Python classifier process so it can be stopped
// cleanly on brick shutdown.
type Subprocess struct {
	cmd  *exec.Cmd
	port int
}

// EnsureRunning makes the classifier reachable. Behavior:
//   - If something already responds on cfg.Address:cfg.Port → returns nil (no-op).
//   - Otherwise, downloads the LoRA + base models via the `hf` CLI (no-op if
//     already cached) and spawns server.py as a detached child process,
//     blocking until /classify responds healthy or a 180s deadline elapses.
//
// Returns a Subprocess (caller must Stop on shutdown) or nil if no spawn
// happened. A non-nil error means the spawn was attempted and failed.
func EnsureRunning(cfg *config.ComplexityServiceConfig) (*Subprocess, error) {
	if cfg == nil || !cfg.Enabled || !cfg.AutoSpawnEnabled() {
		return nil, nil
	}
	if cfg.BaseURL != "" {
		logging.Infof("ComplexityServer: BaseURL=%s configured, skipping local auto-spawn", cfg.BaseURL)
		return nil, nil
	}
	port := cfg.Port
	if port == 0 {
		port = 8093
	}
	addr := cfg.Address
	if addr == "" {
		addr = "127.0.0.1"
	}

	if classifierResponds(addr, port) {
		logging.Infof("ComplexityServer: external classifier already reachable at %s:%d, skipping auto-spawn", addr, port)
		return nil, nil
	}

	scriptPath, err := locateScript(cfg.ScriptPath)
	if err != nil {
		return nil, err
	}

	if err := preDownloadModels(); err != nil {
		logging.Warnf("ComplexityServer: model pre-download failed (%v); spawning anyway, server will retry", err)
	}

	device := cfg.Device
	if device == "" {
		device = "auto"
	}

	cmd := exec.Command("python3", scriptPath, "--port", strconv.Itoa(port), "--device", device)
	cmd.Stdout = newPrefixWriter("[CC] ")
	cmd.Stderr = newPrefixWriter("[CC] ")
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}

	logging.Infof("ComplexityServer: spawning %s --port %d --device %s", scriptPath, port, device)
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("spawn classifier: %w", err)
	}

	sub := &Subprocess{cmd: cmd, port: port}

	deadline := time.Now().Add(180 * time.Second)
	for time.Now().Before(deadline) {
		if classifierResponds("127.0.0.1", port) {
			logging.Infof("ComplexityServer: ready on port %d (PID %d)", port, cmd.Process.Pid)
			return sub, nil
		}
		if cmd.ProcessState != nil && cmd.ProcessState.Exited() {
			return nil, fmt.Errorf("classifier exited prematurely: %s", cmd.ProcessState)
		}
		time.Sleep(2 * time.Second)
	}
	logging.Warnf("ComplexityServer: did not become healthy within 180s; leaving running (PID %d) — first-time model download may still be in progress", cmd.Process.Pid)
	return sub, nil
}

// Stop sends SIGTERM to the spawned process and waits up to 10s for exit.
func (s *Subprocess) Stop() {
	if s == nil || s.cmd == nil || s.cmd.Process == nil {
		return
	}
	logging.Infof("ComplexityServer: stopping (PID %d)", s.cmd.Process.Pid)
	_ = syscall.Kill(-s.cmd.Process.Pid, syscall.SIGTERM)
	done := make(chan struct{})
	go func() { _ = s.cmd.Wait(); close(done) }()
	select {
	case <-done:
	case <-time.After(10 * time.Second):
		_ = syscall.Kill(-s.cmd.Process.Pid, syscall.SIGKILL)
	}
}

func classifierResponds(addr string, port int) bool {
	conn, err := net.DialTimeout("tcp", fmt.Sprintf("%s:%d", addr, port), 1500*time.Millisecond)
	if err != nil {
		return false
	}
	_ = conn.Close()

	client := &http.Client{Timeout: 2 * time.Second}
	resp, err := client.Get(fmt.Sprintf("http://%s:%d/health", addr, port))
	if err != nil {
		return false
	}
	defer resp.Body.Close()
	return resp.StatusCode == 200
}

// locateScript resolves the brick-complexity-server/server.py path. If a
// configured override is provided, it is used as-is. Otherwise the function
// tries a small set of well-known relative locations from the current working
// directory and returns the first one that exists.
func locateScript(override string) (string, error) {
	if override != "" {
		if _, err := os.Stat(override); err != nil {
			return "", fmt.Errorf("complexity_service.script_path %q: %w", override, err)
		}
		return override, nil
	}
	candidates := []string{
		"deploy/addons/brick-complexity-server/server.py",
		"../deploy/addons/brick-complexity-server/server.py",
		"../../deploy/addons/brick-complexity-server/server.py",
	}
	for _, p := range candidates {
		if abs, err := filepath.Abs(p); err == nil {
			if _, err := os.Stat(abs); err == nil {
				return abs, nil
			}
		}
	}
	return "", fmt.Errorf("brick-complexity-server/server.py not found in any default location; set complexity_service.script_path")
}

// preDownloadModels invokes `hf download` for the LoRA + base repos. No-op if
// the `hf` CLI is missing or fails — server.py will fall back to an in-process
// download via the transformers library at first inference.
func preDownloadModels() error {
	if _, err := exec.LookPath("hf"); err != nil {
		logging.Warnf("ComplexityServer: hf CLI not found, deferring model download to server.py first-run")
		return nil
	}
	for _, repo := range []string{LoraRepo, BaseRepo} {
		logging.Infof("ComplexityServer: pre-downloading %s via hf CLI", repo)
		out, err := exec.Command("hf", "download", repo).CombinedOutput()
		if err != nil {
			return fmt.Errorf("hf download %s: %w (output: %s)", repo, err, truncate(string(out), 400))
		}
	}
	return nil
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "...[truncated]"
}

// prefixWriter is a tiny io.Writer that prefixes every line of output (useful
// for tagging the spawned classifier's logs in brick's log stream).
type prefixWriter struct{ prefix string }

func newPrefixWriter(prefix string) *prefixWriter { return &prefixWriter{prefix: prefix} }

func (p *prefixWriter) Write(b []byte) (int, error) {
	logging.Infof("%s%s", p.prefix, string(b))
	return len(b), nil
}
