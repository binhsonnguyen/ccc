// Package ptyrunner spawns `claude --resume <uuid>` inside a PTY so the
// c3-server can pipe its I/O to a browser xterm.js client over WebSocket.
//
// This is the "claude-as-process" adapter used by the server. The CLI uses
// a different (exec) path that replaces the user's shell — both are valid
// ClaudeRunner implementations under the hexagonal split.
package ptyrunner

import (
	"fmt"
	"os"
	"os/exec"

	"github.com/creack/pty"
)

// Start spawns `claude --resume <uuid>` in cwd when uuid is non-empty, or
// just `claude` (no resume) when uuid is empty. The empty-uuid path is for
// brand-new "New session" entries created from the GUI: claude assigns a
// uuid on its own and writes the JSONL; ptymgr's discovery loop watches
// claudefs for the new file and upgrades the c3 entry via usecase.Bind.

// Session is a live PTY + child process pair. The caller owns the master
// file: reading drains stdout/stderr; writing feeds stdin. Resize/Kill/Wait
// mirror the standard PTY ops.
type Session struct {
	Master *os.File
	Cmd    *exec.Cmd
}

// Start spawns `claude --resume <uuid>` in cwd inside a freshly allocated
// pseudo-terminal. TERM=xterm-256color so claude picks the truecolor TUI
// path. Initial size is a sane default; the server will Resize() once the
// browser reports its viewport.
func Start(cwd, uuid string) (*Session, error) {
	var cmd *exec.Cmd
	if uuid == "" {
		// uuid empty = new session; claude will assign one and write its
		// JSONL; the discovery loop in ptymgr upgrades the entry.
		cmd = exec.Command("claude")
	} else {
		cmd = exec.Command("claude", "--resume", uuid)
	}
	cmd.Dir = cwd
	// Inherit env, force TERM so claude doesn't fall back to dumb.
	env := os.Environ()
	env = append(env, "TERM=xterm-256color")
	cmd.Env = env

	master, err := pty.StartWithSize(cmd, &pty.Winsize{Rows: 24, Cols: 80})
	if err != nil {
		return nil, fmt.Errorf("ptyrunner: start: %w", err)
	}
	return &Session{Master: master, Cmd: cmd}, nil
}

// Resize sends TIOCSWINSZ to the PTY. cols/rows = 0 is silently ignored to
// avoid wedging the child with a zero-size terminal during transient
// browser resizes.
func (s *Session) Resize(cols, rows uint16) error {
	if cols == 0 || rows == 0 {
		return nil
	}
	return pty.Setsize(s.Master, &pty.Winsize{Rows: rows, Cols: cols})
}

// Kill SIGKILLs the child process. Caller should still Wait() to reap.
func (s *Session) Kill() error {
	if s.Cmd == nil || s.Cmd.Process == nil {
		return nil
	}
	return s.Cmd.Process.Kill()
}

// Wait blocks until the child exits and returns its exit code. Must be
// called exactly once per Session, after Master EOFs (or you've called
// Kill). Closes Master.
func (s *Session) Wait() (int, error) {
	_ = s.Master.Close()
	err := s.Cmd.Wait()
	if err == nil {
		return 0, nil
	}
	if ee, ok := err.(*exec.ExitError); ok {
		return ee.ExitCode(), nil
	}
	return -1, err
}
