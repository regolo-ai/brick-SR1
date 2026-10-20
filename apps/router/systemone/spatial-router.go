// Package systemone provides Brick's local SystemOne classifier.
// Inference uses a persistent PyTorch/Transformers subprocess, without cgo.
package systemone

import (
	"bufio"
	"context"
	"crypto/sha256"
	_ "embed"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

//go:embed systemone_worker.py
var workerSource string

//go:embed manifest.json
var manifestJSON []byte

const defaultWorkerTimeout = 180 * time.Second

// workerTimeout bounds a single inference round-trip. Overridable through
// BRICK_SYSTEMONE_TIMEOUT (seconds) so slow hosts can raise or lower it.
var workerTimeout = resolveWorkerTimeout()

func resolveWorkerTimeout() time.Duration {
	raw := strings.TrimSpace(os.Getenv("BRICK_SYSTEMONE_TIMEOUT"))
	if raw == "" {
		return defaultWorkerTimeout
	}
	seconds, err := strconv.ParseFloat(raw, 64)
	if err != nil || seconds <= 0 {
		return defaultWorkerTimeout
	}
	return time.Duration(seconds * float64(time.Second))
}

var modelState struct {
	sync.Mutex
	path   string
	worker *inferenceWorker
}

// workerStatus mirrors the active worker state for lock-free reads. The
// inference mutex is held for the whole round-trip, so readiness and metadata
// must not depend on it or /health would block behind a running inference.
var workerStatus struct {
	available atomic.Bool
	lastError atomic.Value // string
	metadata  atomic.Value // workerReply
	path      atomic.Value // string
}

func (w *inferenceWorker) status() workerReply {
	if value, ok := workerStatus.metadata.Load().(workerReply); ok {
		return value
	}
	return workerReply{}
}

type workerReply struct {
	Ready         bool      `json:"ready"`
	Device        string    `json:"device"`
	Dtype         string    `json:"dtype"`
	Attention     string    `json:"attention"`
	Probabilities []float64 `json:"probabilities"`
	Error         string    `json:"error"`
}

type inferenceWorker struct {
	command  *exec.Cmd
	input    io.WriteCloser
	output   *json.Decoder
	metadata workerReply
}

func (w *inferenceWorker) close() {
	_ = w.input.Close()
	if w.command.Process != nil {
		_ = w.command.Process.Kill()
	}
	_ = w.command.Wait()
}

func (w *inferenceWorker) receive(ctx context.Context) (workerReply, error) {
	type response struct {
		reply workerReply
		err   error
	}
	result := make(chan response, 1)
	go func() { var reply workerReply; err := w.output.Decode(&reply); result <- response{reply, err} }()
	timer := time.NewTimer(workerTimeout)
	defer timer.Stop()
	select {
	case value := <-result:
		if value.err != nil {
			return workerReply{}, fmt.Errorf("SystemOne worker protocol: %w", value.err)
		}
		if value.reply.Error != "" {
			return workerReply{}, fmt.Errorf("SystemOne inference: %s", value.reply.Error)
		}
		return value.reply, nil
	case <-timer.C:
		return workerReply{}, fmt.Errorf("SystemOne inference timed out")
	case <-ctx.Done():
		return workerReply{}, ctx.Err()
	}
}

func startWorker(command *exec.Cmd) (*inferenceWorker, error) {
	input, err := command.StdinPipe()
	if err != nil {
		return nil, err
	}
	output, err := command.StdoutPipe()
	if err != nil {
		_ = input.Close()
		return nil, err
	}
	command.Stderr = os.Stderr
	if err = command.Start(); err != nil {
		_ = input.Close()
		_ = output.Close()
		return nil, err
	}
	worker := &inferenceWorker{command: command, input: input, output: json.NewDecoder(bufio.NewReader(output))}
	ready, err := worker.receive(context.Background())
	if err != nil {
		worker.close()
		return nil, err
	}
	if !ready.Ready {
		worker.close()
		return nil, fmt.Errorf("SystemOne worker did not become ready")
	}
	worker.metadata = ready
	return worker, nil
}

// markUnavailable records a failed worker state so /health and /diag report the
// truth instead of a stale readiness flag. The last known path is kept for
// diagnostics.
func markUnavailable(err error) {
	workerStatus.available.Store(false)
	if err != nil {
		workerStatus.lastError.Store(err.Error())
	}
}

// markAvailable records a healthy worker together with its runtime metadata.
func markAvailable(path string, metadata workerReply) {
	workerStatus.metadata.Store(metadata)
	workerStatus.path.Store(path)
	workerStatus.lastError.Store("")
	workerStatus.available.Store(true)
}

// Available reports whether a live SystemOne worker is currently loaded.
func Available() bool {
	return workerStatus.available.Load()
}

// LastError returns the most recent worker failure, or an empty string.
func LastError() string {
	if value, ok := workerStatus.lastError.Load().(string); ok {
		return value
	}
	return ""
}

// Init loads verified local assets once per Go process.
// BRICK_SYSTEMONE_PYTHON selects a Python interpreter with torch and transformers.
func Init(modelPath string) error {
	if strings.ContainsRune(modelPath, 0) {
		return fmt.Errorf("model path contains NUL")
	}
	path, err := filepath.Abs(modelPath)
	if err != nil {
		return err
	}
	path, err = filepath.EvalSymlinks(path)
	if err != nil {
		return fmt.Errorf("model directory unavailable: %w", err)
	}
	modelState.Lock()
	defer modelState.Unlock()
	if modelState.worker != nil {
		if modelState.path != path {
			return fmt.Errorf("another checkpoint is loaded")
		}
		markAvailable(path, modelState.worker.metadata)
		return nil
	}
	if err := VerifyAssets(path); err != nil {
		markUnavailable(err)
		return err
	}
	python := os.Getenv("BRICK_SYSTEMONE_PYTHON")
	if python == "" {
		python = "python3"
	}
	worker, err := startWorker(exec.Command(python, "-u", "-c", workerSource, path))
	if err != nil {
		error := fmt.Errorf("initialize SystemOne (requires Python, torch and transformers): %w", err)
		markUnavailable(error)
		return error
	}
	modelState.path = path
	modelState.worker = worker
	markAvailable(path, worker.metadata)
	return nil
}

// Classify runs one inference with a background deadline.
func Classify(text string) ([]float64, error) {
	return ClassifyContext(context.Background(), text)
}

// ClassifyContext runs one inference, aborting when ctx is done. The worker
// protocol is synchronous, so a cancellation kills the worker; the next call
// re-initializes it through Init rather than staying broken forever.
func ClassifyContext(ctx context.Context, text string) ([]float64, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if strings.ContainsRune(text, 0) {
		return nil, fmt.Errorf("classifier input contains NUL")
	}
	modelState.Lock()
	defer modelState.Unlock()
	if modelState.worker == nil {
		return nil, fmt.Errorf("SystemOne model not loaded")
	}
	worker := modelState.worker
	invalidate := func(cause error) {
		worker.close()
		modelState.worker = nil
		modelState.path = ""
		markUnavailable(cause)
	}
	if err := json.NewEncoder(worker.input).Encode(map[string]string{"text": text}); err != nil {
		invalidate(err)
		return nil, err
	}
	reply, err := worker.receive(ctx)
	if err != nil {
		invalidate(err)
		return nil, err
	}
	if len(reply.Probabilities) != 6 {
		err := fmt.Errorf("SystemOne returned an invalid vector shape")
		invalidate(err)
		return nil, err
	}
	for _, value := range reply.Probabilities {
		if math.IsNaN(float64(value)) || math.IsInf(float64(value), 0) || value < 0 || value > 1 {
			err := fmt.Errorf("SystemOne returned an invalid vector value")
			invalidate(err)
			return nil, err
		}
	}
	result := make([]float64, 6)
	for i, value := range reply.Probabilities {
		result[i] = value
	}
	return result, nil
}

// VerifyAssets rejects local checkpoints that differ from the pinned SystemOne revision.
func VerifyAssets(path string) error {
	var manifest struct {
		Files map[string]struct {
			SHA256 string `json:"sha256"`
			Bytes  int64  `json:"bytes"`
		} `json:"files"`
	}
	if err := json.Unmarshal(manifestJSON, &manifest); err != nil {
		return err
	}
	for name, expected := range manifest.Files {
		file, err := os.Open(filepath.Join(path, name))
		if err != nil {
			return fmt.Errorf("SystemOne asset unavailable: %s", name)
		}
		hash := sha256.New()
		size, err := io.Copy(hash, file)
		_ = file.Close()
		if err != nil || size != expected.Bytes || fmt.Sprintf("%x", hash.Sum(nil)) != expected.SHA256 {
			return fmt.Errorf("SystemOne checksum verification failed: %s", name)
		}
	}
	return nil
}

// Info reports local engine readiness and the pinned checkpoint identity.
// It never takes the inference mutex, so diagnostics stay responsive while a
// request is in flight.
func Info() map[string]interface{} {
	var manifest struct {
		Repository string `json:"repository"`
		Revision   string `json:"revision"`
	}
	_ = json.Unmarshal(manifestJSON, &manifest)
	metadata := workerStatus.metadata.Load()
	info := map[string]interface{}{"engine": "pytorch-transformers", "model": manifest.Repository, "revision": manifest.Revision, "ready": Available()}
	if reply, ok := metadata.(workerReply); ok && Available() {
		info["device"] = reply.Device
		info["dtype"] = reply.Dtype
		info["attention"] = reply.Attention
	}
	if err := LastError(); err != "" {
		info["last_error"] = err
	}
	if path, ok := workerStatus.path.Load().(string); ok {
		info["path"] = path
	}
	return info
}
