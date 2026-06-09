// service.go — `c3 service {start|stop|status}` manages an always-on
// c3-server background service, replacing the formula-only `brew services`
// path (casks can't define services). The app owns its own lifecycle here:
// a LaunchAgent on macOS, a systemd --user unit on Linux. Either way the
// server runs with C3_SERVER_IDLE_MINUTES=0 so it never auto-quits.
//
// `status` reuses the same server.port discovery file the GUI uses, so it
// reports the real running state regardless of how the server was started
// (service, `c3 gui`, or a manual launch).
package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"time"
)

const serviceLabel = "com.c3.server" // launchd label / systemd unit base

func cmdService(args []string) error {
	if len(args) == 0 {
		return fmt.Errorf("service: missing subcommand (start, stop, or status)")
	}
	switch args[0] {
	case "start":
		return serviceStart()
	case "stop":
		return serviceStop()
	case "status":
		return serviceStatus()
	default:
		return fmt.Errorf("service: unknown subcommand %q (use start, stop, or status)", args[0])
	}
}

func serviceStart() error {
	exe, err := findServerBinaryStable()
	if err != nil {
		return err
	}
	// If a server is already serving (typically a `c3 gui`-spawned one), the
	// service's own c3-server will fail to bind the port and the supervisor
	// (KeepAlive / Restart=on-failure) will crash-loop while the discovery
	// file still shows the *other* process alive. Warn up front rather than
	// letting confirmStarted report a misleading success.
	if portFile, perr := portFilePath(); perr == nil {
		if port, alive := readAlivePort(portFile); alive {
			fmt.Fprintf(os.Stderr,
				"c3: note: a c3-server is already running on port %d. If it was "+
					"started by `c3 gui` it will hold the port and the service can't "+
					"bind it — stop that one first.\n", port)
		}
	}
	switch runtime.GOOS {
	case "darwin":
		return serviceStartDarwin(exe)
	case "linux":
		return serviceStartLinux(exe)
	default:
		return fmt.Errorf("service: unsupported OS %q", runtime.GOOS)
	}
}

// findServerBinaryStable resolves c3-server to a path that stays valid across
// `brew upgrade`. Unlike findServerBinary (used for one-shot detached spawns,
// where resolving symlinks is fine), the service bakes this path into a
// persistent LaunchAgent/systemd unit, so it must NOT resolve into the
// versioned Caskroom dir — that dir is replaced on upgrade. exec.LookPath
// returns the on-PATH entry as-is (the stable HOMEBREW_PREFIX/bin symlink, or
// ~/.local/bin for source installs); only fall back to the alongside-exe path
// (un-resolved) for dev runs where c3-server isn't on PATH.
func findServerBinaryStable() (string, error) {
	if path, err := exec.LookPath("c3-server"); err == nil {
		return path, nil
	}
	if exe, err := os.Executable(); err == nil {
		cand := filepath.Join(filepath.Dir(exe), "c3-server")
		if st, err := os.Stat(cand); err == nil && !st.IsDir() {
			return cand, nil
		}
	}
	return "", fmt.Errorf("c3-server binary not found on PATH or alongside c3-bin")
}

func serviceStop() error {
	// Idempotent: stopping a service that isn't loaded is a no-op success, so
	// scripts can `c3 service stop` defensively without checking first.
	if !serviceLoaded() {
		fmt.Println("c3: service not running")
		return nil
	}
	switch runtime.GOOS {
	case "darwin":
		return serviceStopDarwin()
	case "linux":
		return serviceStopLinux()
	default:
		return fmt.Errorf("service: unsupported OS %q", runtime.GOOS)
	}
}

// serviceStatus reports the server's serving state (via the discovery file)
// and the service's real supervisor state — distinguishing "loaded/active"
// from "unit file on disk but stopped" from "not installed". These are
// independent: the server may be running from `c3 gui` with no unit at all,
// or a unit file may linger after `stop` (macOS bootout keeps the plist).
func serviceStatus() error {
	portFile, err := portFilePath()
	if err != nil {
		return err
	}
	if port, alive := readAlivePort(portFile); alive {
		fmt.Printf("server: running (http://127.0.0.1:%d)\n", port)
	} else {
		fmt.Println("server: not running")
	}

	installed, where := serviceInstalled()
	switch {
	case serviceLoaded():
		fmt.Printf("service: active (%s)\n", where)
	case installed:
		fmt.Println("service: stopped (unit installed) — start with `c3 service start`")
	default:
		fmt.Println("service: not installed — run `c3 service start`")
	}
	return nil
}

// serviceLoaded reports whether the platform supervisor currently has the
// service loaded/active — not merely whether the unit file exists on disk
// (macOS `stop` boots the job out but keeps the plist).
func serviceLoaded() bool {
	switch runtime.GOOS {
	case "darwin":
		target := fmt.Sprintf("gui/%d/%s", os.Getuid(), serviceLabel)
		return exec.Command("launchctl", "print", target).Run() == nil
	case "linux":
		return exec.Command("systemctl", "--user", "is-active", "--quiet", serviceLabel+".service").Run() == nil
	default:
		return false
	}
}

// ---- macOS (launchd) -------------------------------------------------------

func launchAgentPlistPath() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, "Library", "LaunchAgents", serviceLabel+".plist"), nil
}

const launchAgentPlist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>%s</string>
  <key>ProgramArguments</key>
  <array>
    <string>%s</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>C3_SERVER_IDLE_MINUTES</key>
    <string>0</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>%s</string>
  <key>StandardErrorPath</key>
  <string>%s</string>
</dict>
</plist>
`

func serviceStartDarwin(exe string) error {
	plist, err := launchAgentPlistPath()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(plist), 0o755); err != nil {
		return err
	}
	logPath, err := serverLogPath()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(logPath), 0o755); err != nil {
		return err
	}
	content := fmt.Sprintf(launchAgentPlist, serviceLabel, exe, logPath, logPath)
	if err := os.WriteFile(plist, []byte(content), 0o644); err != nil {
		return err
	}

	domain := fmt.Sprintf("gui/%d", os.Getuid())
	// Reload idempotently: bootout any prior instance (ignore "not loaded"),
	// then bootstrap the freshly written plist. bootstrap+RunAtLoad starts it.
	_ = exec.Command("launchctl", "bootout", domain+"/"+serviceLabel).Run()
	if out, err := exec.Command("launchctl", "bootstrap", domain, plist).CombinedOutput(); err != nil {
		return fmt.Errorf("launchctl bootstrap failed: %v: %s", err, out)
	}
	return confirmStarted()
}

func serviceStopDarwin() error {
	domain := fmt.Sprintf("gui/%d", os.Getuid())
	if out, err := exec.Command("launchctl", "bootout", domain+"/"+serviceLabel).CombinedOutput(); err != nil {
		return fmt.Errorf("launchctl bootout failed (service not running?): %v: %s", err, out)
	}
	fmt.Println("c3: service stopped")
	return nil
}

// ---- Linux (systemd --user) ------------------------------------------------

func systemdUnitPath() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".config", "systemd", "user", serviceLabel+".service"), nil
}

const systemdUnit = `[Unit]
Description=c3-server (Claude Code session manager web GUI)
After=network.target

[Service]
ExecStart=%s
Environment=C3_SERVER_IDLE_MINUTES=0
Restart=on-failure

[Install]
WantedBy=default.target
`

func serviceStartLinux(exe string) error {
	unit, err := systemdUnitPath()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(unit), 0o755); err != nil {
		return err
	}
	content := fmt.Sprintf(systemdUnit, exe)
	if err := os.WriteFile(unit, []byte(content), 0o644); err != nil {
		return err
	}
	if out, err := exec.Command("systemctl", "--user", "daemon-reload").CombinedOutput(); err != nil {
		return fmt.Errorf("systemctl daemon-reload failed: %v: %s", err, out)
	}
	if out, err := exec.Command("systemctl", "--user", "enable", "--now", serviceLabel+".service").CombinedOutput(); err != nil {
		return fmt.Errorf("systemctl enable --now failed: %v: %s", err, out)
	}
	return confirmStarted()
}

func serviceStopLinux() error {
	if out, err := exec.Command("systemctl", "--user", "disable", "--now", serviceLabel+".service").CombinedOutput(); err != nil {
		return fmt.Errorf("systemctl disable --now failed: %v: %s", err, out)
	}
	fmt.Println("c3: service stopped")
	return nil
}

// ---- shared ----------------------------------------------------------------

// serviceInstalled reports whether the platform's unit file exists and where.
func serviceInstalled() (bool, string) {
	var path string
	switch runtime.GOOS {
	case "darwin":
		path, _ = launchAgentPlistPath()
	case "linux":
		path, _ = systemdUnitPath()
	default:
		return false, ""
	}
	if path == "" {
		return false, ""
	}
	if _, err := os.Stat(path); err != nil {
		return false, ""
	}
	return true, path
}

// confirmStarted polls the discovery file so `start` reports the real URL
// once the server is up, instead of returning before it has bound the port.
func confirmStarted() error {
	portFile, err := portFilePath()
	if err != nil {
		return err
	}
	port, err := waitForPort(portFile, 5*time.Second)
	if err != nil {
		return fmt.Errorf("service started but server did not come up: %w", err)
	}
	fmt.Printf("c3: service started (http://127.0.0.1:%d)\n", port)
	return nil
}
