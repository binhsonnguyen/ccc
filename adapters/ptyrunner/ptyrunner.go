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

// Start spawns claude in cwd. Command shape depends on (uuid, firstPrompt):
//
//	uuid != "" && firstPrompt != ""  → claude --session-id <uuid> <firstPrompt>
//	uuid == "" && firstPrompt != ""  → claude <firstPrompt>
//	uuid != "" && firstPrompt == ""  → claude --resume <uuid>
//	uuid == "" && firstPrompt == ""  → claude
//
// The first two shapes pre-fill + auto-submit the prompt inside claude's
// TUI (verified against claude CLI 2026-05). The fourth is the original
// "new pending session" path used by both CLI and GUI before the inline
// first-prompt flow existed.

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
func Start(cwd, uuid, firstPrompt string) (*Session, error) {
	claudePath, err := resolveClaude()
	if err != nil {
		return nil, fmt.Errorf("ptyrunner: %w", err)
	}
	var cmd *exec.Cmd
	switch {
	case uuid != "" && firstPrompt != "":
		// Pre-assigned uuid + prompt → inline first-prompt flow.
		// claude --session-id <uuid> "<prompt>" pre-fills + auto-submits
		// in the TUI; the JSONL appears at the server's chosen uuid so
		// no discovery rebind is needed. firstPrompt is passed as a
		// single positional arg — exec.Command handles quoting; do NOT
		// shell out, multi-line + backticks must survive verbatim.
		cmd = exec.Command(claudePath, "--session-id", uuid, firstPrompt)
	case uuid == "" && firstPrompt != "":
		// No uuid (server didn't pre-assign) but the user wants their
		// prompt auto-submitted. claude picks its own uuid; discovery
		// loop rebinds.
		cmd = exec.Command(claudePath, firstPrompt)
	case uuid != "" && firstPrompt == "":
		// Classic resume flow: re-attach to an existing claude session.
		cmd = exec.Command(claudePath, "--resume", uuid)
	default:
		// Pending new session: claude assigns a uuid and writes its
		// JSONL; the discovery loop in ptymgr upgrades the entry.
		cmd = exec.Command(claudePath)
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

// StartShell spawns a plain shell PTY in cwd. argv == nil ⇒ default
// (`$SHELL -i`; `/bin/bash -i` when SHELL is empty). Non-nil argv is
// used verbatim; argv[0] is resolved via exec.LookPath. No PATH-fallback
// scan like resolveClaude — shells are universally on PATH and a custom
// argv is the user's contract.
//
// IMPORTANT: this path must NOT write anything under ~/.claude/projects.
// We don't touch claudefs from here and we don't pass --session-id to
// anything; verified by TestStartShell_DoesNotCreateClaudeJSONL.
func StartShell(cwd string, argv []string) (*Session, error) {
	if argv == nil {
		sh := os.Getenv("SHELL")
		if sh == "" {
			sh = "/bin/bash"
		}
		argv = []string{sh, "-i"}
	}
	if len(argv) == 0 {
		return nil, fmt.Errorf("ptyrunner: empty argv")
	}
	bin, err := exec.LookPath(argv[0])
	if err != nil {
		return nil, fmt.Errorf("ptyrunner: shell %q not found: %w", argv[0], err)
	}
	cmd := exec.Command(bin, argv[1:]...)
	cmd.Dir = cwd
	env := os.Environ()
	env = append(env, "TERM=xterm-256color")
	env = augmentPath(env)
	cmd.Env = env

	master, err := pty.StartWithSize(cmd, &pty.Winsize{Rows: 24, Cols: 80})
	if err != nil {
		return nil, fmt.Errorf("ptyrunner: start shell: %w", err)
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
