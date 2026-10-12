// Package systemone provides Brick's local SystemOne classifier.
// Inference uses a persistent PyTorch/Transformers subprocess, without cgo.
package systemone

import (
	"bufio"
	"crypto/sha256"
	_ "embed"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

//go:embed systemone_worker.py
var workerSource string

//go:embed manifest.json
var manifestJSON []byte

const workerTimeout = 180 * time.Second

var modelState struct {
	sync.Mutex
	path   string
	worker *inferenceWorker
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

func (w *inferenceWorker) receive() (workerReply, error) {
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
	ready, err := worker.receive()
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
		return nil
	}
	if err := VerifyAssets(path); err != nil {
		return err
	}
	python := os.Getenv("BRICK_SYSTEMONE_PYTHON")
	if python == "" {
		python = "python3"
	}
	worker, err := startWorker(exec.Command(python, "-u", "-c", workerSource, path))
	if err != nil {
		return fmt.Errorf("initialize SystemOne (requires Python, torch and transformers): %w", err)
	}
	modelState.path = path
	modelState.worker = worker
	return nil
}

func Classify(text string) ([]float64, error) {
	if strings.ContainsRune(text, 0) {
		return nil, fmt.Errorf("classifier input contains NUL")
	}
	modelState.Lock()
	defer modelState.Unlock()
	if modelState.worker == nil {
		return nil, fmt.Errorf("SystemOne model not loaded")
	}
	worker := modelState.worker
	invalidate := func() { worker.close(); modelState.worker = nil; modelState.path = "" }
	if err := json.NewEncoder(worker.input).Encode(map[string]string{"text": text}); err != nil {
		invalidate()
		return nil, err
	}
	reply, err := worker.receive()
	if err != nil {
		invalidate()
		return nil, err
	}
	if len(reply.Probabilities) != 6 {
		invalidate()
		return nil, fmt.Errorf("SystemOne returned an invalid vector shape")
	}
	for _, value := range reply.Probabilities {
		if math.IsNaN(float64(value)) || math.IsInf(float64(value), 0) || value < 0 || value > 1 {
			invalidate()
			return nil, fmt.Errorf("SystemOne returned an invalid vector value")
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
func Info() map[string]interface{} {
	modelState.Lock()
	defer modelState.Unlock()
	var manifest struct {
		Repository string `json:"repository"`
		Revision   string `json:"revision"`
	}
	_ = json.Unmarshal(manifestJSON, &manifest)
	info := map[string]interface{}{"engine": "pytorch-transformers", "model": manifest.Repository, "revision": manifest.Revision, "ready": modelState.worker != nil}
	if modelState.worker != nil {
		info["device"] = modelState.worker.metadata.Device
		info["dtype"] = modelState.worker.metadata.Dtype
		info["attention"] = modelState.worker.metadata.Attention
	}
	return info
}
