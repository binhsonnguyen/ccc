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
	"path/filepath"
	"strings"

	"github.com/creack/pty"
)

// fallbackBinDirs is the list of directories searched for `claude` when
// the process PATH doesn't surface it. Covers the common install paths
// for npm-based, manual, and Homebrew installs. Order matters: user-
// local installs take precedence over system-wide.
//
// This matters because c3-server may be launched by launchd (via
// `brew services start c3`) or systemd, which inherit a minimal PATH
// that doesn't include the user's npm/.local locations. Without this
// fallback the user sees "exec: claude: not found" the first time
// they try to attach a session.
func fallbackBinDirs() []string {
	home, err := os.UserHomeDir()
	if err != nil {
		home = ""
	}
	out := []string{}
	if home != "" {
		out = append(out,
			filepath.Join(home, ".local/bin"),
			filepath.Join(home, ".npm-global/bin"),
			filepath.Join(home, "bin"),
			filepath.Join(home, ".volta/bin"),
		)
	}
	out = append(out, "/opt/homebrew/bin", "/usr/local/bin")
	return out
}

// resolveClaude returns the absolute path to the `claude` binary. First
// tries exec.LookPath (honors current PATH); if that fails, walks the
// fallbackBinDirs list. Returns a clear error when nothing usable is
// found so the server log + client error frame can surface it.
func resolveClaude() (string, error) {
	if p, err := exec.LookPath("claude"); err == nil {
		return p, nil
	}
	for _, dir := range fallbackBinDirs() {
		candidate := filepath.Join(dir, "claude")
		info, err := os.Stat(candidate)
		if err != nil || info.IsDir() {
			continue
		}
		if info.Mode()&0o111 == 0 {
			continue // not executable
		}
		return candidate, nil
	}
	return "", fmt.Errorf("claude not found in PATH or common install dirs (%s); install claude or add its bin dir to PATH",
		strings.Join(fallbackBinDirs(), ", "))
}

// augmentPath returns env with PATH prepended by fallbackBinDirs that
// aren't already there. Preserves any existing PATH entry. Used so
// claude (and any tools claude spawns) can find their deps even when
// c3-server itself was started by launchd / systemd with a stripped
// environment.
func augmentPath(env []string) []string {
	cur := ""
	idx := -1
	for i, kv := range env {
		if strings.HasPrefix(kv, "PATH=") {
			cur = strings.TrimPrefix(kv, "PATH=")
			idx = i
			break
		}
	}
	existing := map[string]bool{}
	for _, d := range strings.Split(cur, ":") {
		if d != "" {
			existing[d] = true
		}
	}
	var add []string
	for _, d := range fallbackBinDirs() {
		if d == "" || existing[d] {
			continue
		}
		add = append(add, d)
		existing[d] = true
	}
	if len(add) == 0 {
		return env
	}
	next := strings.Join(add, ":")
	if cur != "" {
		next = next + ":" + cur
	}
	kv := "PATH=" + next
	if idx >= 0 {
		out := make([]string, len(env))
		copy(out, env)
		out[idx] = kv
		return out
	}
	return append(env, kv)
}

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
	claudePath, err := resolveClaude()
	if err != nil {
		return nil, fmt.Errorf("ptyrunner: %w", err)
	}
	var cmd *exec.Cmd
	if uuid == "" {
		// uuid empty = new session; claude will assign one and write its
		// JSONL; the discovery loop in ptymgr upgrades the entry.
		cmd = exec.Command(claudePath)
	} else {
		cmd = exec.Command(claudePath, "--resume", uuid)
	}
	cmd.Dir = cwd
	// Inherit env, force TERM so claude doesn't fall back to dumb. Also
	// prepend the fallback bin dirs to PATH so claude itself can find
	// any auxiliary tools (node, npx, etc.) it might exec — same
	// reasoning as resolveClaude.
	env := os.Environ()
	env = append(env, "TERM=xterm-256color")
	env = augmentPath(env)
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
