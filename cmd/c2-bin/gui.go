// gui.go — `c2 gui` subcommand: opens the local web UI in the default
// browser. Spawns c2-server detached if not already running (discovery
// via ~/.local/share/cc/server.port, same file the server writes).
//
// Detached spawn rules:
//   - Setsid so the child becomes a session leader; killing c2-bin (the
//     shell wrapper) does NOT propagate SIGHUP/SIGTERM down to the server.
//   - Stdio reattached to /dev/null + a log file. Inheriting c2-bin's
//     fds would (a) keep the parent shell's pipe open and (b) cause the
//     server to print to the user's terminal asynchronously.
//   - We do NOT Wait() on the child — that's exactly what "detached"
//     means here.
package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"time"
)

func cmdGUI() error {
	portFile, err := portFilePath()
	if err != nil {
		return err
	}

	// 1. Fast path: server already running. Just open the browser.
	if port, alive := readAlivePort(portFile); alive {
		url := fmt.Sprintf("http://127.0.0.1:%d", port)
		fmt.Fprintf(os.Stderr, "c2: GUI already running at %s\n", url)
		return openBrowser(url)
	}

	// 2. Spawn c2-server detached.
	serverExe, err := findServerBinary()
	if err != nil {
		return err
	}
	if err := spawnDetached(serverExe); err != nil {
		return fmt.Errorf("spawn c2-server: %w", err)
	}

	// 3. Poll the discovery file until the server writes its port.
	port, err := waitForPort(portFile, 5*time.Second)
	if err != nil {
		return err
	}
	url := fmt.Sprintf("http://127.0.0.1:%d", port)
	fmt.Fprintf(os.Stderr, "c2: GUI running at %s\n", url)
	return openBrowser(url)
}

// findServerBinary looks for c2-server alongside the current executable
// first (so a `make install` keeps the pair together), then falls back
// to PATH for development.
func findServerBinary() (string, error) {
	if exe, err := os.Executable(); err == nil {
		// Resolve symlinks so we land in the real bin/ dir even if the
		// user is running from a wrapper symlink.
		if real, err := filepath.EvalSymlinks(exe); err == nil {
			exe = real
		}
		cand := filepath.Join(filepath.Dir(exe), "c2-server")
		if st, err := os.Stat(cand); err == nil && !st.IsDir() {
			return cand, nil
		}
	}
	if path, err := exec.LookPath("c2-server"); err == nil {
		return path, nil
	}
	return "", fmt.Errorf("c2-server binary not found alongside c2-bin or on PATH")
}

// spawnDetached starts the server in a new session with stdio reattached
// so it survives c2-bin exit and doesn't share the user's terminal fds.
func spawnDetached(exe string) error {
	logPath, err := serverLogPath()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(logPath), 0o755); err != nil {
		return err
	}
	logf, err := os.OpenFile(logPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		return err
	}
	// Don't close logf here — the child needs the fd. The kernel reaps it
	// when the child exits. We do close *our* handle after Start() because
	// the syscall has already dup'd it into the child.
	defer logf.Close()

	devNull, err := os.OpenFile(os.DevNull, os.O_RDONLY, 0)
	if err != nil {
		return err
	}
	defer devNull.Close()

	cmd := exec.Command(exe)
	cmd.Stdin = devNull
	cmd.Stdout = logf
	cmd.Stderr = logf
	// Detach: new session, no controlling terminal.
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	return cmd.Start()
}

// waitForPort polls the discovery file until the server writes it (with
// a live pid) or the deadline expires.
func waitForPort(path string, timeout time.Duration) (int, error) {
	deadline := time.Now().Add(timeout)
	for {
		if port, alive := readAlivePort(path); alive {
			return port, nil
		}
		if time.Now().After(deadline) {
			return 0, fmt.Errorf("timeout waiting for c2-server to start (check %s)", mustServerLogPath())
		}
		time.Sleep(75 * time.Millisecond)
	}
}

// openBrowser invokes the platform-native "open URL" helper. We
// deliberately don't bring in a third-party browser library; `open` /
// `xdg-open` covers macOS+Linux which is the supported set.
func openBrowser(url string) error {
	var opener string
	switch runtime.GOOS {
	case "darwin":
		opener = "open"
	case "linux":
		opener = "xdg-open"
	default:
		fmt.Fprintf(os.Stderr, "c2: please open %s manually (unsupported OS: %s)\n", url, runtime.GOOS)
		return nil
	}
	// LookPath first so a missing `xdg-open` on minimal Linux installs
	// surfaces as a helpful hint, not a silent fork failure. Start()
	// instead of Run() afterwards is still correct: the browser process
	// must outlive c2-bin.
	if _, err := exec.LookPath(opener); err != nil {
		fmt.Fprintf(os.Stderr, "c2: browser open failed (%s not found); open %s manually\n", opener, url)
		return nil
	}
	if err := exec.Command(opener, url).Start(); err != nil {
		fmt.Fprintf(os.Stderr, "c2: browser open failed (%v); open %s manually\n", err, url)
		return nil
	}
	return nil
}

// ---------------------------------------------------------------------------
// Discovery file (mirrors c2-server's logic — kept in sync deliberately;
// extracting to a shared package isn't worth the cycle yet).
// ---------------------------------------------------------------------------

func portFilePath() (string, error) {
	if d := os.Getenv("XDG_DATA_HOME"); d != "" {
		return filepath.Join(d, "cc", "server.port"), nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".local", "share", "cc", "server.port"), nil
}

func serverLogPath() (string, error) {
	if d := os.Getenv("XDG_STATE_HOME"); d != "" {
		return filepath.Join(d, "cc", "server.log"), nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".local", "state", "cc", "server.log"), nil
}

func mustServerLogPath() string {
	p, err := serverLogPath()
	if err != nil {
		return "<server log>"
	}
	return p
}

func readAlivePort(path string) (int, bool) {
	b, err := os.ReadFile(path)
	if err != nil {
		return 0, false
	}
	lines := strings.Split(strings.TrimSpace(string(b)), "\n")
	if len(lines) < 2 {
		return 0, false
	}
	port, err := strconv.Atoi(strings.TrimSpace(lines[0]))
	if err != nil {
		return 0, false
	}
	pid, err := strconv.Atoi(strings.TrimSpace(lines[1]))
	if err != nil {
		return 0, false
	}
	proc, err := os.FindProcess(pid)
	if err != nil {
		return 0, false
	}
	if err := proc.Signal(syscall.Signal(0)); err != nil {
		return 0, false
	}
	return port, true
}
