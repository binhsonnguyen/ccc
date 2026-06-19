// Package ptyrunner spawns `claude --resume <uuid>` inside a PTY so the
// c3-server can pipe its I/O to a browser xterm.js client over WebSocket.
//
// This is the "claude-as-process" adapter used by the server. The CLI uses
// a different (exec) path that replaces the user's shell — both are valid
// ClaudeRunner implementations under the hexagonal split.
package ptyrunner

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

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

// ensureUTF8Locale returns env with a UTF-8 LANG injected when no locale
// is configured at all. Without this, children inherit an empty/"C"
// locale and macOS programs (zsh's line editor, claude/node, etc.) fall
// back to the legacy Mac Roman 8-bit charset: typed/echoed UTF-8 bytes
// get reinterpreted as Mac Roman glyphs, so "Tiếng Việt" surfaces in the
// xterm buffer (and therefore in copied text) as mojibake like
// "Ti·∫øng Vi·ªát".
//
// This bites specifically because c3-server is usually launched by
// launchd (`brew services start c3`), whose environment has no LANG /
// LC_* at all — and the login shell's init files don't set them either
// (Terminal.app/iTerm normally export LANG themselves, a step we have to
// reproduce here). Same minimal-environment trap as augmentPath.
//
// We only act when the locale is entirely unset: if LC_ALL, LC_CTYPE, or
// LANG is already present we respect the user's explicit choice. LANG is
// the lowest-priority default, so injecting it never overrides a more
// specific LC_* the user did set. en_US.UTF-8 is used because it is
// universally available on macOS (unlike C.UTF-8, which is Linux-only).
func ensureUTF8Locale(env []string) []string {
	for _, kv := range env {
		if v := localeValue(kv, "LC_ALL"); v != "" {
			return env
		}
		if v := localeValue(kv, "LC_CTYPE"); v != "" {
			return env
		}
		if v := localeValue(kv, "LANG"); v != "" {
			return env
		}
	}
	return append(env, "LANG=en_US.UTF-8")
}

// localeValue returns the value of kv if it is the `key=...` assignment,
// else "". Empty assignments (e.g. "LANG=") count as unset.
func localeValue(kv, key string) string {
	if strings.HasPrefix(kv, key+"=") {
		return strings.TrimPrefix(kv, key+"=")
	}
	return ""
}

var (
	loginEnvOnce sync.Once
	loginEnvVal  []string
)

// loginShellEnv resolves the user's interactive login-shell environment
// once and caches it for the lifetime of the process.
//
// c3-server is typically launched by launchd (`brew services start c3`),
// which hands it a stripped environment: no LANG/LC_*, a bare
// /usr/bin:/bin PATH, and none of the user's tool-manager vars (NVM_BIN,
// PNPM_HOME, BUN_INSTALL, JAVA_HOME, …). Spawning PTY children straight
// from os.Environ() therefore starves them — claude can't find the user's
// node/pnpm, UTF-8 text degrades to Mac Roman mojibake, editors/pagers
// are unset, and so on. Each gap previously needed its own band-aid
// (augmentPath for PATH, ensureUTF8Locale for LANG).
//
// Instead we do what Terminal.app / iTerm (and VS Code's "resolve shell
// environment") do: run the login shell once, dump its environment, and
// use that as the base for every PTY. -l AND -i so both the login files
// (.zprofile/.zlogin) and the interactive rc (.zshrc — where LANG/PATH
// tweaks usually live) are sourced. `env -0` emits NUL-delimited
// KEY=VALUE so values containing newlines survive intact.
//
// Returns nil on any failure (no SHELL, lookup miss, timeout, empty
// output); callers then fall back to os.Environ() + the targeted fixups.
func loginShellEnv() []string {
	loginEnvOnce.Do(func() { loginEnvVal = resolveLoginShellEnv() })
	return loginEnvVal
}

func resolveLoginShellEnv() []string {
	sh := os.Getenv("SHELL")
	if sh == "" {
		sh = "/bin/bash"
	}
	bin, err := exec.LookPath(sh)
	if err != nil {
		return nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, bin, "-l", "-i", "-c", "env -0")
	var out bytes.Buffer
	cmd.Stdout = &out
	// Discard the interactive shell's chatter (prompts, plugin warnings,
	// gitstatus init noise) — we only care about the NUL-delimited env on
	// stdout. Stdin stays nil so `-i` never blocks waiting for input.
	cmd.Stderr = nil
	_ = cmd.Run() // partial stdout is still usable; parseEnv0 validates.
	return parseEnv0(out.Bytes())
}

// parseEnv0 splits NUL-delimited `env -0` output into a []string of
// "KEY=VALUE" entries, dropping anything that isn't a well-formed
// assignment with a non-empty key. Returns nil if nothing usable parses.
func parseEnv0(b []byte) []string {
	var env []string
	for _, p := range bytes.Split(b, []byte{0}) {
		if eq := bytes.IndexByte(p, '='); eq > 0 {
			env = append(env, string(p))
		}
	}
	if len(env) == 0 {
		return nil
	}
	return env
}

// setEnv replaces the value of key in env, or appends it when absent.
func setEnv(env []string, key, val string) []string {
	prefix := key + "="
	for i, kv := range env {
		if strings.HasPrefix(kv, prefix) {
			out := make([]string, len(env))
			copy(out, env)
			out[i] = prefix + val
			return out
		}
	}
	return append(env, prefix+val)
}

// delEnv returns env with any assignment of key removed. No-op when absent.
func delEnv(env []string, key string) []string {
	prefix := key + "="
	out := env[:0:0]
	for _, kv := range env {
		if strings.HasPrefix(kv, prefix) {
			continue
		}
		out = append(out, kv)
	}
	return out
}

// EnvOverlay, when set by the server, returns per-spawn environment
// overrides applied on top of the resolved login-shell base for every PTY.
// It is the injection point for the active LLM-provider profile
// (ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN / model-mapping vars).
//
// Map semantics: a non-empty value sets KEY=value; an empty value UNSETS
// KEY (so switching to a provider that doesn't define a var strips a stale
// one inherited from the user's shell rc). Nil hook or empty map ⇒ no
// overlay, i.e. the original thin-wrapper passthrough.
//
// Called fresh on every spawn (see childEnv) so a UI toggle takes effect on
// the next session without a daemon restart. ptyrunner deliberately does
// not import the provider package — the server wires this var — so this
// adapter stays dependency-free.
var EnvOverlay func() map[string]string

// applyEnvOverlay applies the EnvOverlay map to env (see EnvOverlay docs).
func applyEnvOverlay(env []string, overlay map[string]string) []string {
	for k, v := range overlay {
		if v == "" {
			env = delEnv(env, k)
		} else {
			env = setEnv(env, k, v)
		}
	}
	return env
}

// childEnv builds the environment for a spawned PTY child. It prefers the
// resolved login-shell environment and degrades to os.Environ() when that
// can't be obtained. Either way it then forces TERM (so claude picks the
// truecolor TUI) and runs the PATH/locale safety nets, so even a partial
// or missing login env still yields a workable terminal.
func childEnv() []string {
	base := loginShellEnv()
	if base == nil {
		base = os.Environ()
	}
	env := buildChildEnv(base)
	// Overlay the active provider profile last so it wins over both the
	// login-shell env and the safety-net fixups. Read fresh each spawn.
	if EnvOverlay != nil {
		env = applyEnvOverlay(env, EnvOverlay())
	}
	return env
}

// buildChildEnv is the pure core of childEnv, split out for testing.
func buildChildEnv(base []string) []string {
	base = setEnv(base, "TERM", "xterm-256color")
	base = augmentPath(base)
	base = ensureUTF8Locale(base)
	return base
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
	// Base the child env on the user's resolved login-shell environment
	// (full PATH, locale, tool-manager vars), with TERM forced and the
	// PATH/locale safety nets applied. See childEnv / loginShellEnv.
	cmd.Env = childEnv()

	master, err := pty.StartWithSize(cmd, &pty.Winsize{Rows: 24, Cols: 80})
	if err != nil {
		return nil, fmt.Errorf("ptyrunner: start: %w", err)
	}
	return &Session{Master: master, Cmd: cmd}, nil
}

// StartShell spawns a plain shell PTY in cwd. argv == nil ⇒ default
// (`$SHELL -l -i`; `/bin/bash -l -i` when SHELL is empty). Non-nil argv
// is used verbatim; argv[0] is resolved via exec.LookPath. No PATH-
// fallback scan like resolveClaude — shells are universally on PATH and
// a custom argv is the user's contract.
//
// We pass BOTH -l (login) and -i (interactive) so the shell sources the
// login init files (.zprofile/.zlogin, .bash_profile) in addition to
// the interactive rc (.zshrc/.bashrc). This matches Terminal.app /
// iTerm / VSCode, which all launch login+interactive shells. Without -l
// the daemon's stripped launchd PATH never gets the augmentation that
// most tool managers (Homebrew shellenv, pnpm/PNPM_HOME, nvm, volta)
// place in .zprofile — leading to "pnpm: not found" etc. inside c3
// shell tabs even though the same command works in VSCode.
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
		argv = []string{sh, "-l", "-i"}
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
	// Same resolved-login-shell base as Start. The shell will re-source
	// its init files on top (harmless: exports are idempotent), but now
	// it starts from a complete env instead of launchd's stripped one.
	cmd.Env = childEnv()

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
