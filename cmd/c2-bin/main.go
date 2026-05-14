// c2-bin is the c2 CLI binary. See DESIGN.md for protocol with the wrapper.
package main

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"c2/internal/picker"
	"c2/internal/sessions"
	"c2/internal/store"
)

const usage = `c2 — manage your curated Claude Code sessions

Usage:
  c2                  open the c2-session picker
                        Enter   resume highlighted
                        Ctrl-N  new session (pick a directory)
                        Ctrl-B  bind: adopt an existing Claude session
                        Ctrl-A  archive highlighted
  c2 <query>          picker pre-filtered by query
  c2 -1 <query>       resume directly if exactly one match
  c2 new [name]       create a new c2-session (prompts for directory) and spawn claude
  c2 bind             open Claude-session picker; adopt the chosen one
  c2 archive <id>     toggle archive (in c2 only — Claude files untouched)
  c2 -a               picker over archived c2-sessions
  c2 rename <id> <name>
  c2 rm <id>          remove c2-session entry (Claude session left intact)
  c2 -h, --help       show this help

Environment:
  C2_NO_WRAPPER=1     also echo eval'd command to stderr
`

func main() {
	if err := run(os.Args[1:]); err != nil {
		if errors.Is(err, picker.ErrCancelled) {
			os.Exit(130)
		}
		fmt.Fprintln(os.Stderr, "c2:", err)
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
	}
	q := strings.Join(args, " ")
	return runPicker(picker.Options{Query: q}, false)
}

// runPicker is the heart of `c2` — load store, lazy-link pending entries,
// show picker, dispatch on user action.
func runPicker(opts picker.Options, archivedView bool) error {
	f, err := store.Load()
	if err != nil {
		return err
	}
	if err := lazyLink(f); err != nil {
		fmt.Fprintln(os.Stderr, "c2: warn:", err)
	}

	entries := f.Active(false)
	if archivedView {
		// Show only archived
		archivedSet := map[string]bool{}
		for _, id := range f.Archived {
			archivedSet[id] = true
		}
		entries = nil
		for _, e := range f.Sessions {
			if archivedSet[e.ID] {
				entries = append(entries, e)
			}
		}
	}

	res, err := picker.PickC2(entries, opts)
	if err != nil {
		return err
	}
	switch res.Action {
	case picker.ActionResume:
		if res.Entry.ClaudeUUID == "" {
			return fmt.Errorf("session %s has no Claude UUID yet — start it once with `claude` in %s",
				res.Entry.Name, res.Entry.CWD)
		}
		emit(emitResume(res.Entry.CWD, res.Entry.ClaudeUUID))
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
	e := f.Add(name, dir, "")
	if err := store.Save(f); err != nil {
		return err
	}
	fmt.Fprintf(os.Stderr, "c2: created session %s (%s) in %s — Claude UUID will link on next `c2`\n", e.Name, e.ID, dir)
	emit(fmt.Sprintf("cd %s && claude", shellQuote(dir)))
	return nil
}

// pickNewDir gathers candidates and shows the dir picker. PWD is always first
// (default highlight). Then unique cwds from c2-sessions, then unique cwds
// from raw Claude sessions, both ordered by recency. Duplicates dropped.
func pickNewDir(pwd string, f *store.File) (string, error) {
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

	// c2-session cwds, sorted by createdAt desc (Active() already returns this order).
	for _, e := range f.Active(true) {
		add("[c2]", e.CWD)
	}

	// Claude raw session cwds, sorted by mtime desc.
	if ss, err := sessions.Scan(); err == nil {
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
	ss, err := sessions.Scan()
	if err != nil {
		return err
	}
	f, err := store.Load()
	if err != nil {
		return err
	}
	// Filter: hide already-bound Claude UUIDs.
	bound := map[string]bool{}
	for _, e := range f.Sessions {
		if e.ClaudeUUID != "" {
			bound[e.ClaudeUUID] = true
		}
	}
	var unbound []sessions.Session
	for _, s := range ss {
		if !s.Sidechain && !bound[s.UUID] {
			unbound = append(unbound, s)
		}
	}
	if len(unbound) == 0 {
		return fmt.Errorf("no unbound Claude sessions to adopt")
	}
	chosen, err := picker.PickClaude(unbound, picker.Options{})
	if err != nil {
		return err
	}
	name := filepath.Base(chosen.CWD)
	e := f.Add(name, chosen.CWD, chosen.UUID)
	if err := store.Save(f); err != nil {
		return err
	}
	fmt.Fprintf(os.Stderr, "c2: bound %s → %s (%s)\n", chosen.UUID[:8], e.Name, e.ID)
	emit(emitResume(e.CWD, e.ClaudeUUID))
	return nil
}

func cmdArchive(args []string) error {
	if len(args) != 1 {
		return fmt.Errorf("usage: c2 archive <id>")
	}
	f, err := store.Load()
	if err != nil {
		return err
	}
	e := f.Find(args[0])
	if e == nil {
		return fmt.Errorf("no session with id %s", args[0])
	}
	now := f.Archive(args[0])
	if err := store.Save(f); err != nil {
		return err
	}
	state := "unarchived"
	if now {
		state = "archived"
	}
	fmt.Fprintf(os.Stderr, "c2: %s %s\n", state, e.Name)
	return nil
}

func cmdRename(args []string) error {
	if len(args) < 2 {
		return fmt.Errorf("usage: c2 rename <id> <new name...>")
	}
	f, err := store.Load()
	if err != nil {
		return err
	}
	e := f.Find(args[0])
	if e == nil {
		return fmt.Errorf("no session with id %s", args[0])
	}
	e.Name = strings.Join(args[1:], " ")
	if err := store.Save(f); err != nil {
		return err
	}
	fmt.Fprintf(os.Stderr, "c2: renamed %s → %s\n", args[0], e.Name)
	return nil
}

func cmdRemove(args []string) error {
	if len(args) != 1 {
		return fmt.Errorf("usage: c2 rm <id>")
	}
	f, err := store.Load()
	if err != nil {
		return err
	}
	for i, e := range f.Sessions {
		if e.ID == args[0] {
			f.Sessions = append(f.Sessions[:i], f.Sessions[i+1:]...)
			f.Archive(args[0]) // remove from archived list if present
			f.Archive(args[0]) // toggle back if it wasn't there (no-op)
			// Cleaner: just drop the id from Archived directly.
			cleanArchived(f, args[0])
			if err := store.Save(f); err != nil {
				return err
			}
			fmt.Fprintf(os.Stderr, "c2: removed %s (%s)\n", args[0], e.Name)
			return nil
		}
	}
	return fmt.Errorf("no session with id %s", args[0])
}

// cmdPickerAction is invoked by fzf's `reload` binding. It mutates the
// store, then prints the updated picker rows to stdout (which fzf consumes
// as its new list). All info goes to stderr to keep stdout clean.
//
// Usage:
//
//	c2-bin --picker-action archive [--archived-view] <id>
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
		return fmt.Errorf("usage: c2-bin --picker-action archive [--archived-view] <id>")
	}
	action, rest := args[0], args[1:]

	switch action {
	case "archive":
		if len(rest) != 1 || rest[0] == "" {
			// Empty {1} (no row selected) — just re-emit current view.
			return emitRows(archivedView)
		}
		id := rest[0]
		f, err := store.Load()
		if err != nil {
			return err
		}
		if f.Find(id) == nil {
			// Stale id (already removed). Silently re-emit.
			return emitRows(archivedView)
		}
		f.Archive(id)
		if err := store.Save(f); err != nil {
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
	var entries []store.Entry
	if archivedView {
		archivedSet := map[string]bool{}
		for _, id := range f.Archived {
			archivedSet[id] = true
		}
		for _, e := range f.Sessions {
			if archivedSet[e.ID] {
				entries = append(entries, e)
			}
		}
	} else {
		entries = f.Active(false)
	}
	rows := picker.FormatC2Rows(entries)
	if len(rows) == 0 {
		// fzf reload with empty input clears the list. Provide a hint row
		// matching the empty-state convention used in PickC2.
		fmt.Println("\t(no sessions — press Ctrl-N to create or Ctrl-B to bind one)")
		return nil
	}
	fmt.Println(strings.Join(rows, "\n"))
	return nil
}

func cleanArchived(f *store.File, id string) {
	for i, a := range f.Archived {
		if a == id {
			f.Archived = append(f.Archived[:i], f.Archived[i+1:]...)
			return
		}
	}
}

// lazyLink fills in ClaudeUUID for any c2-session that's still pending,
// by matching cwd + creation time against Claude's session storage.
func lazyLink(f *store.File) error {
	pending := false
	for _, e := range f.Sessions {
		if e.ClaudeUUID == "" {
			pending = true
			break
		}
	}
	if !pending {
		return nil
	}
	ss, err := sessions.Scan()
	if err != nil {
		return err
	}
	bound := map[string]bool{}
	for _, e := range f.Sessions {
		if e.ClaudeUUID != "" {
			bound[e.ClaudeUUID] = true
		}
	}
	changed := false
	for i := range f.Sessions {
		e := &f.Sessions[i]
		if e.ClaudeUUID != "" {
			continue
		}
		// Best match: same cwd, modified after createdAt, not yet bound,
		// most recent first.
		var best *sessions.Session
		for j := range ss {
			s := &ss[j]
			if s.CWD != e.CWD {
				continue
			}
			// Strict: only link to Claude sessions that have activity AFTER
			// this c2-session was created. Avoids accidentally adopting
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
			changed = true
			fmt.Fprintf(os.Stderr, "c2: linked %s → %s\n", e.Name, best.UUID[:8])
		}
	}
	if changed {
		return store.Save(f)
	}
	return nil
}

func emitResume(cwd, uuid string) string {
	// No `exec` — keep the user's shell alive so the terminal tab stays open
	// after they Ctrl+C out of claude. Trade-off: one extra process in the
	// tree, negligible.
	return fmt.Sprintf("cd %s && claude --resume %s", shellQuote(cwd), uuid)
}

func emit(cmd string) {
	fmt.Println(cmd)
	if os.Getenv("C2_NO_WRAPPER") == "1" {
		fmt.Fprintln(os.Stderr, "c2: would run:", cmd)
	}
}

func shellQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}

