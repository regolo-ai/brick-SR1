//go:build !linux

package systemone

import "os/exec"

// bindToParent is a no-op outside Linux, where no portable parent-death signal
// exists; the worker is still closed explicitly on shutdown.
func bindToParent(command *exec.Cmd) {}
