// c3-bin is the c3 CLI binary. See DESIGN.md for protocol with the wrapper.
package main

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"

	"github.com/binhsonnguyen/ccc/adapters/archivejson"
	"github.com/binhsonnguyen/ccc/adapters/claudefs"
	"github.com/binhsonnguyen/ccc/core"
	"github.com/binhsonnguyen/ccc/core/usecase"
	"github.com/binhsonnguyen/ccc/internal/picker"
)

const usage = `c3 — manage your curated Claude Code sessions

Usage:
  c3                  open the c3-session picker
                        Enter   resume highlighted
                        Ctrl-N  new session (pick a directory)
                        Ctrl-B  bind: adopt an existing Claude session
                        Ctrl-A  archive highlighted
  c3 <query>          picker pre-filtered by query
  c3 -1 <query>       resume directly if exactly one match
  c3 new [name]       create a new c3-session (prompts for directory) and spawn claude
  c3 bind             open Claude-session picker; adopt the chosen one
  c3 archive <id>     toggle archive (in c3 only — Claude files untouched)
  c3 -a               picker over archived c3-sessions
  c3 rename <id> <name>
  c3 rm <id>          remove c3-session entry (Claude session left intact)
  c3 gui              open the local web UI in your browser (spawns
                        c3-server detached if not already running)
  c3 -h, --help       show this help
  c3 -v, --version    show version

Environment:
  C3_NO_WRAPPER=1     also echo eval'd command to stderr
  C3_SERVER_PORT=N    c3-server listen port (default 7755; 0 = random)
  C3_SERVER_IDLE_MINUTES=N  shut server down after N min idle (default 15, 0 = off)
`

var store = archivejson.New()

// version is set at build time via -ldflags "-X main.version=…".
// "dev" is the default for plain `go build` / `go install` so users
// can tell an install-from-source build apart from a release binary.
var version = "dev"

func main() {
	if err := run(os.Args[1:]); err != nil {
		if errors.Is(err, picker.ErrCancelled) {
			os.Exit(130)
		}
		fmt.Fprintln(os.Stderr, "c3:", err)
		os.Exit(1)
	}
}

func run(args []string) error {
	if len(args) == 0 {
		return runPicker(picker.Options{}, false)
	}
	switch args[0] {
	case "-h", "--help":
		fmt.Fprint(os.Stderr, usage)
		return nil
	case "-v", "--version":
		fmt.Println(version)
		return nil
	case "-a":
		return runPicker(picker.Options{ArchivedView: true}, true)
	case "-1":
		q := strings.Join(args[1:], " ")
		return runPicker(picker.Options{Query: q, AutoOne: true}, false)
	case "new":
		return cmdNew(args[1:])
	case "bind":
		return cmdBind()
	case "archive":
		return cmdArchive(args[1:])
	case "rename":
		return cmdRename(args[1:])
	case "rm":
		return cmdRemove(args[1:])
	case "--picker-action":
		return cmdPickerAction(args[1:])
	case "gui":
		return cmdGUI()
	}
	q := strings.Join(args, " ")
	return runPicker(picker.Options{Query: q}, false)
}

// runPicker is the heart of `c3` — load store, lazy-link pending entries,
// show picker, dispatch on user action.
func runPicker(opts picker.Options, archivedView bool) error {
	if err := lazyLink(); err != nil {
		fmt.Fprintln(os.Stderr, "c3: warn:", err)
	}
	f, err := store.Load()
	if err != nil {
		return err
	}

	var entries []core.C3Entry
	if archivedView {
		entries = f.ListArchived()
	} else {
		entries = f.ListActive()
	}
	// CLI surface decision (v1): the c3 fzf picker is claude-only. Shell
	// entries are GUI-only — there's no resume command to emit, and the
	// fzf picker has no idea how to spawn a shell tab. Filter them out at
	// the picker boundary so the rest of the CLI (rename / archive / rm by
	// id) still works on shell entries when the user knows the id.
	entries = filterOutShell(entries)

	res, err := picker.PickC3(entries, opts)
	if err != nil {
		return err
	}
	switch res.Action {
	case picker.ActionResume:
		e := res.Entry
		if e.ClaudeUUID == "" {
			return fmt.Errorf("session %s has no Claude UUID yet — start it once with `claude` in %s",
				e.Name, e.CWD)
		}
		emit(emitResume(e.CWD, e.ClaudeUUID))
		return nil
	case picker.ActionNew:
		return cmdNew(nil)
	case picker.ActionBind:
		return cmdBind()
	}
	return nil
}

func cmdNew(args []string) error {
	pwd, err := os.Getwd()
	if err != nil {
		return err
	}
	// Pick a directory first (read-only over current state) so we don't hold
	// the store lock during the interactive fzf prompt.
	f, err := store.Load()
	if err != nil {
		return err
	}
	dir, err := pickNewDir(pwd, f)
	if err != nil {
		return err
	}
	name := filepath.Base(dir)
	if len(args) > 0 {
		name = strings.Join(args, " ")
	}
	var created core.C3Entry
	if err := store.Mutate(func(f *core.ArchiveFile) error {
		created = f.AddEntry(name, dir, "")
		return nil
	}); err != nil {
		return err
	}
	fmt.Fprintf(os.Stderr, "c3: created session %s (%s) in %s — Claude UUID will link on next `c3`\n", created.Name, created.ID, dir)
	emit(fmt.Sprintf("cd %s && claude", shellQuote(dir)))
	return nil
}

// pickNewDir gathers candidates and shows the dir picker. PWD is always first
// (default highlight). Then unique cwds from c3-sessions, then unique cwds
// from raw Claude sessions, both ordered by recency. Duplicates dropped.
func pickNewDir(pwd string, f *core.ArchiveFile) (string, error) {
	seen := map[string]bool{}
	var cands []picker.DirCandidate
	add := func(label, path string) {
		if path == "" || seen[path] {
			return
		}
		seen[path] = true
		cands = append(cands, picker.DirCandidate{Path: path, Label: label})
	}
	add("[PWD]", pwd)

	// c3-session cwds, sorted by createdAt desc.
	for _, e := range f.ListAll() {
		add("[c3]", e.CWD)
	}

	// Claude raw session cwds, sorted by mtime desc.
	if ss, err := claudefs.New().Scan(); err == nil {
		for _, s := range ss {
			if s.Sidechain {
				continue
			}
			add("[claude]", s.CWD)
		}
	}

	return picker.PickDir(cands)
}

func cmdBind() error {
	ss, err := claudefs.New().Scan()
	if err != nil {
		return err
	}
	// Read-only snapshot to compute the unbound list for the picker.
	f, err := store.Load()
	if err != nil {
		return err
	}
	unbound := f.UnboundClaudeSessions(ss)
	if len(unbound) == 0 {
		return fmt.Errorf("no unbound Claude sessions to adopt")
	}
	chosen, err := picker.PickClaude(unbound, picker.Options{})
	if err != nil {
		return err
	}
	name := filepath.Base(chosen.CWD)
	var created core.C3Entry
	if err := store.Mutate(func(f *core.ArchiveFile) error {
		// Re-check inside the lock: another c3 may have bound this uuid.
		for _, e := range f.Sessions {
			if e.ClaudeUUID == chosen.UUID {
				return fmt.Errorf("session %s already bound", chosen.UUID[:8])
			}
		}
		created = f.AddEntry(name, chosen.CWD, chosen.UUID)
		return nil
	}); err != nil {
		return err
	}
	fmt.Fprintf(os.Stderr, "c3: bound %s → %s (%s)\n", chosen.UUID[:8], created.Name, created.ID)
	emit(emitResume(created.CWD, created.ClaudeUUID))
	return nil
}

func cmdArchive(args []string) error {
	if len(args) != 1 {
		return fmt.Errorf("usage: c3 archive <id>")
	}
	entry, now, err := usecase.ToggleArchive(store, args[0])
	if err != nil {
		return err
	}
	state := "unarchived"
	if now {
		state = "archived"
	}
	fmt.Fprintf(os.Stderr, "c3: %s %s\n", state, entry.Name)
	return nil
}

func cmdRename(args []string) error {
	if len(args) < 2 {
		return fmt.Errorf("usage: c3 rename <id> <new name...>")
	}
	newName := strings.Join(args[1:], " ")
	if _, err := usecase.Rename(store, args[0], newName); err != nil {
		// Preserve pre-PR error wording so users + tests see the same
		// stderr line. The use-case wraps ErrNotFound with the id, which
		// matches the previous "no session with id <id>" format.
		return err
	}
	fmt.Fprintf(os.Stderr, "c3: renamed %s → %s\n", args[0], newName)
	return nil
}

func cmdRemove(args []string) error {
	if len(args) != 1 {
		return fmt.Errorf("usage: c3 rm <id>")
	}
	// CLI runs in-process without a PTY manager — pass nil to skip the
	// live-PTY gate. The "server is running" hint below is the user's
	// signal that a separate process may still have a live session.
	// First fetch the name so the success line matches the pre-PR output.
	f, err := store.Load()
	if err != nil {
		return err
	}
	e := f.Find(args[0])
	if e == nil {
		return fmt.Errorf("no session with id %s", args[0])
	}
	removedName := e.Name
	if err := usecase.Remove(store, args[0], false, nil); err != nil {
		return err
	}
	fmt.Fprintf(os.Stderr, "c3: removed %s (%s)\n", args[0], removedName)
	if serverIsAlive() {
		fmt.Fprintln(os.Stderr,
			"c3: note: c3-server is running. Any live PTY for this session "+
				"keeps running there until you close its tab in the GUI or "+
				"restart the server.")
	}
	return nil
}

// serverIsAlive reports whether ~/.local/share/c3/server.port points at a
// running c3-server. Best-effort; returns false on any error.
func serverIsAlive() bool {
	dir := os.Getenv("XDG_DATA_HOME")
	if dir == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return false
		}
		dir = filepath.Join(home, ".local", "share")
	}
	b, err := os.ReadFile(filepath.Join(dir, "c3", "server.port"))
	if err != nil {
		return false
	}
	lines := strings.SplitN(strings.TrimSpace(string(b)), "\n", 2)
	if len(lines) < 2 {
		return false
	}
	pid, err := strconv.Atoi(strings.TrimSpace(lines[1]))
	if err != nil {
		return false
	}
	p, err := os.FindProcess(pid)
	if err != nil {
		return false
	}
	return p.Signal(syscall.Signal(0)) == nil
}

// cmdPickerAction is invoked by fzf's `reload` binding. It mutates the
// store, then prints the updated picker rows to stdout (which fzf consumes
// as its new list). All info goes to stderr to keep stdout clean.
//
// Usage:
//
//	c3-bin --picker-action archive [--archived-view] <id>
func cmdPickerAction(args []string) error {
	archivedView := false
	for len(args) > 0 && strings.HasPrefix(args[0], "--") {
		if args[0] == "--archived-view" {
			archivedView = true
			args = args[1:]
			continue
		}
		return fmt.Errorf("unknown picker-action flag: %s", args[0])
	}
	if len(args) < 1 {
		return fmt.Errorf("usage: c3-bin --picker-action archive [--archived-view] <id>")
	}
	action, rest := args[0], args[1:]

	switch action {
	case "archive":
		if len(rest) != 1 || rest[0] == "" {
			// Empty {1} (no row selected) — just re-emit current view.
			return emitRows(archivedView)
		}
		id := rest[0]
		if err := store.Mutate(func(f *core.ArchiveFile) error {
			if f.Find(id) == nil {
				// Stale id (already removed). Silently no-op.
				return nil
			}
			f.ToggleArchive(id)
			return nil
		}); err != nil {
			return err
		}
		return emitRows(archivedView)
	}
	return fmt.Errorf("unknown picker-action: %s", action)
}

// emitRows writes the picker row format to stdout for fzf's reload to consume.
func emitRows(archivedView bool) error {
	f, err := store.Load()
	if err != nil {
		return err
	}
	var entries []core.C3Entry
	if archivedView {
		entries = f.ListArchived()
	} else {
		entries = f.ListActive()
	}
	entries = filterOutShell(entries)
	rows := picker.FormatC3Rows(entries)
	if len(rows) == 0 {
		// fzf reload with empty input clears the list. Provide a hint row
		// matching the empty-state convention used in PickC3.
		fmt.Println("\t(no sessions — press Ctrl-N to create or Ctrl-B to bind one)")
		return nil
	}
	fmt.Println(strings.Join(rows, "\n"))
	return nil
}

// lazyLink fills in ClaudeUUID for any c3-session that's still pending,
// by matching cwd + creation time against Claude's session storage.
//
// CRITICAL: shell entries (Kind == "shell") have ClaudeUUID == "" forever
// by design. They must NEVER be auto-bound to a claude uuid even if a
// claude JSONL happens to appear in the same cwd. Both the pre-check and
// the in-lock loop filter on IsShell() so a shell row can't accidentally
// adopt a claude session that was started in the same project dir from
// another terminal.
func lazyLink() error {
	// Cheap read-only check first to avoid taking the lock on every invocation.
	f, err := store.Load()
	if err != nil {
		return err
	}
	pending := false
	for i := range f.Sessions {
		e := &f.Sessions[i]
		if e.IsShell() {
			continue
		}
		if e.ClaudeUUID == "" {
			pending = true
			break
		}
	}
	if !pending {
		return nil
	}
	ss, err := claudefs.New().Scan()
	if err != nil {
		return err
	}
	return store.Mutate(func(f *core.ArchiveFile) error {
		bound := map[string]bool{}
		for _, e := range f.Sessions {
			if e.ClaudeUUID != "" {
				bound[e.ClaudeUUID] = true
			}
		}
		for i := range f.Sessions {
			e := &f.Sessions[i]
			if e.IsShell() {
				// Shell entries: ClaudeUUID stays "" for life; never bind.
				continue
			}
			if e.ClaudeUUID != "" {
				continue
			}
			// Best match: same cwd, modified after createdAt, not yet bound,
			// most recent first.
			var best *core.Session
			for j := range ss {
				s := &ss[j]
				if s.CWD != e.CWD {
					continue
				}
				// Strict: only link to Claude sessions that have activity AFTER
				// this c3-session was created. Avoids accidentally adopting
				// a pre-existing session that happens to share the cwd.
				if !s.Modified.After(e.CreatedAt) {
					continue
				}
				if bound[s.UUID] {
					continue
				}
				if best == nil || s.Modified.After(best.Modified) {
					best = s
				}
			}
			if best != nil {
				e.ClaudeUUID = best.UUID
				bound[best.UUID] = true
				fmt.Fprintf(os.Stderr, "c3: linked %s → %s\n", e.Name, best.UUID[:8])
			}
		}
		return nil
	})
}

func emitResume(cwd, uuid string) string {
	// No `exec` — keep the user's shell alive so the terminal tab stays open
	// after they Ctrl+C out of claude. Trade-off: one extra process in the
	// tree, negligible.
	return fmt.Sprintf("cd %s && claude --resume %s", shellQuote(cwd), uuid)
}

func emit(cmd string) {
	fmt.Println(cmd)
	if os.Getenv("C3_NO_WRAPPER") == "1" {
		fmt.Fprintln(os.Stderr, "c3: would run:", cmd)
	}
}

// filterOutShell drops shell entries from a slice of c3 entries. Used at
// the picker boundary so the fzf list stays claude-only — shell tabs are
// GUI-only in v1 because the CLI has no notion of spawning $SHELL -i
// inside a tab; the emitted command for a picker selection is shaped for
// `claude --resume <uuid>`.
func filterOutShell(in []core.C3Entry) []core.C3Entry {
	out := make([]core.C3Entry, 0, len(in))
	for _, e := range in {
		if e.IsShell() {
			continue
		}
		out = append(out, e)
	}
	return out
}

func shellQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}
