//go:build linux

package systemone

import (
	"os/exec"
	"syscall"
)

// bindToParent kills the inference worker when the runtime process dies, so a
// crash or a stalled shutdown can never leave a multi-gigabyte Python process
// behind.
func bindToParent(command *exec.Cmd) {
	command.SysProcAttr = &syscall.SysProcAttr{Pdeathsig: syscall.SIGKILL}
}
