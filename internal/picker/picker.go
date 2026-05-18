// Package picker shells out to fzf to let the user select a session.
//
// Two pickers:
//   - PickC3: over user's curated c3-sessions. Hotkeys: enter / ctrl-n / ctrl-b / ctrl-a.
//   - PickClaude: over all Claude raw sessions, used by the bind flow.
package picker

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/binhsonnguyen/ccc/core"
)

var (
	ErrCancelled  = errors.New("picker cancelled")
	ErrFzfMissing = errors.New("fzf not installed; run `brew install fzf`")
)

// Action is what the user did in the c3 picker.
type Action int

const (
	ActionResume Action = iota // user pressed Enter on a row
	ActionNew                  // user pressed Ctrl-N
	ActionBind                 // user pressed Ctrl-B
)

// C3Result is what PickC3 returns.
type C3Result struct {
	Action Action
	Entry  *core.C3Entry // populated when Action == ActionResume
}

// PickC3 shows the c3-session picker and returns what the user did.
// `entries` are already filtered (active vs archived) by the caller.
func PickC3(entries []core.C3Entry, opts Options) (*C3Result, error) {
	if err := requireFzf(); err != nil {
		return nil, err
	}

	rows := FormatC3Rows(entries)
	idx := map[string]*core.C3Entry{}
	for i := range entries {
		idx[entries[i].ID] = &entries[i]
	}

	args := baseFzfArgs(opts)
	header := "enter resume · ctrl-n new · ctrl-b bind · ctrl-a archive · esc quit"
	if opts.ArchivedView {
		header = "enter resume · ctrl-a unarchive · esc quit"
	}
	// Ctrl-A: archive/unarchive in place. The reload command re-prints the
	// list (post-mutation) and fzf swaps its source. {1} = the uuid column.
	viewFlag := ""
	if opts.ArchivedView {
		viewFlag = " --archived-view"
	}
	reloadCmd := fmt.Sprintf("c3-bin --picker-action archive%s {1}", viewFlag)
	args = append(args,
		"--header="+header,
		"--expect=ctrl-n,ctrl-b",
		"--bind=ctrl-a:reload("+reloadCmd+")",
	)

	// Empty list → still launch fzf so user can press Ctrl-N or Ctrl-B.
	stdin := strings.Join(rows, "\n")
	if stdin == "" {
		stdin = "\t(no sessions yet — press Ctrl-N to create or Ctrl-B to bind one)"
		// This row has empty uuid column; selecting it would no-op.
	}

	out, key, err := runFzf(args, stdin)
	if err != nil {
		return nil, err
	}

	switch key {
	case "ctrl-n":
		return &C3Result{Action: ActionNew}, nil
	case "ctrl-b":
		return &C3Result{Action: ActionBind}, nil
	}

	// Resume case
	if out == "" {
		return nil, ErrCancelled
	}
	id := strings.SplitN(out, "\t", 2)[0]
	e, ok := idx[id]
	if !ok {
		return nil, fmt.Errorf("picked unknown id %q", id)
	}
	return &C3Result{Action: ActionResume, Entry: e}, nil
}

// DirCandidate is one row offered to the user when picking a directory.
type DirCandidate struct {
	Path  string
	Label string // shown in the picker; describes the source ("[PWD]", "[c3]", "[claude]")
}

// PickDir shows a directory picker over the given candidates. The first
// candidate is highlighted by default.
func PickDir(candidates []DirCandidate) (string, error) {
	if err := requireFzf(); err != nil {
		return "", err
	}
	if len(candidates) == 0 {
		return "", fmt.Errorf("no directory candidates")
	}
	var sb strings.Builder
	for _, c := range candidates {
		sb.WriteString(c.Path)
		sb.WriteByte('\t')
		sb.WriteString(fmt.Sprintf("%-9s  %s", c.Label, c.Path))
		sb.WriteByte('\n')
	}
	args := []string{
		"--ansi",
		"--with-nth=2..",
		"--delimiter=\t",
		"--height=80%",
		"--reverse",
		"--prompt=dir> ",
		"--header=pick a directory for the new session · esc cancel",
		"--no-sort", // preserve our PWD-first ordering
	}
	out, _, err := runFzf(args, strings.TrimRight(sb.String(), "\n"))
	if err != nil {
		return "", err
	}
	if out == "" {
		return "", ErrCancelled
	}
	return strings.SplitN(out, "\t", 2)[0], nil
}

// PickClaude shows all Claude sessions for the bind flow. Returns the chosen
// session, or ErrCancelled.
func PickClaude(ss []core.Session, opts Options) (*core.Session, error) {
	if err := requireFzf(); err != nil {
		return nil, err
	}
	rows := formatClaudeRows(ss)
	idx := map[string]*core.Session{}
	for i := range ss {
		idx[ss[i].UUID] = &ss[i]
	}
	args := baseFzfArgs(opts)
	args = append(args, "--header=bind: pick a Claude session to adopt · esc quit")
	out, _, err := runFzf(args, strings.Join(rows, "\n"))
	if err != nil {
		return nil, err
	}
	if out == "" {
		return nil, ErrCancelled
	}
	uuid := strings.SplitN(out, "\t", 2)[0]
	s, ok := idx[uuid]
	if !ok {
		return nil, fmt.Errorf("picked unknown uuid %q", uuid)
	}
	return s, nil
}

// Options configures any picker invocation.
type Options struct {
	Query        string
	AutoOne      bool
	ArchivedView bool // for header text only
}

func requireFzf() error {
	if _, err := exec.LookPath("fzf"); err != nil {
		return ErrFzfMissing
	}
	return nil
}

func baseFzfArgs(opts Options) []string {
	args := []string{
		"--ansi",
		"--with-nth=2..",
		"--delimiter=\t",
		"--height=80%",
		"--reverse",
		"--prompt=c3> ",
	}
	if opts.Query != "" {
		args = append(args, "--query="+opts.Query)
	}
	if opts.AutoOne {
		args = append(args, "--select-1", "--exit-0")
	}
	return args
}

// runFzf invokes fzf with `--expect` support. Returns (selectedRow, expectedKey, error).
// If --expect was passed and the user pressed one of those keys, key is set
// (and selectedRow may be empty when no row was highlighted).
func runFzf(args []string, stdin string) (selected, key string, err error) {
	cmd := exec.Command("fzf", args...)
	cmd.Stdin = strings.NewReader(stdin)
	cmd.Stderr = os.Stderr
	out, err := cmd.Output()
	if err != nil {
		var ee *exec.ExitError
		if errors.As(err, &ee) {
			switch ee.ExitCode() {
			case 1, 130:
				return "", "", ErrCancelled
			}
		}
		return "", "", fmt.Errorf("fzf: %w", err)
	}
	lines := strings.Split(strings.TrimRight(string(out), "\n"), "\n")
	// With --expect: first line is the key (empty if Enter), second is selection.
	// Without --expect: just the selection.
	for _, a := range args {
		if strings.HasPrefix(a, "--expect=") {
			if len(lines) >= 2 {
				return lines[1], lines[0], nil
			}
			if len(lines) == 1 {
				return "", lines[0], nil
			}
			return "", "", ErrCancelled
		}
	}
	if len(lines) > 0 {
		return lines[0], "", nil
	}
	return "", "", ErrCancelled
}

// FormatC3Rows formats entries for fzf input. Exported so the
// --picker-action callback can re-emit the same format on reload.
func FormatC3Rows(entries []core.C3Entry) []string {
	rows := make([]string, 0, len(entries))
	now := time.Now()
	for _, e := range entries {
		status := ""
		if e.ClaudeUUID == "" {
			status = "[pending]"
		}
		display := fmt.Sprintf("%-12s  %-22s  %s  %s",
			ago(now, e.CreatedAt),
			truncate(e.Name, 22),
			truncate(e.CWD, 40),
			status,
		)
		rows = append(rows, e.ID+"\t"+display)
	}
	return rows
}

func formatClaudeRows(ss []core.Session) []string {
	rows := make([]string, 0, len(ss))
	now := time.Now()
	for _, s := range ss {
		display := fmt.Sprintf("%-12s  %-22s  %s",
			ago(now, s.Modified),
			truncate(filepath.Base(s.CWD), 22),
			s.Summary,
		)
		rows = append(rows, s.UUID+"\t"+display)
	}
	return rows
}

func ago(now, t time.Time) string {
	if t.IsZero() {
		return "?"
	}
	d := now.Sub(t)
	switch {
	case d < time.Minute:
		return "just now"
	case d < time.Hour:
		return fmt.Sprintf("%dm ago", int(d.Minutes()))
	case d < 24*time.Hour:
		return fmt.Sprintf("%dh ago", int(d.Hours()))
	case d < 30*24*time.Hour:
		return fmt.Sprintf("%dd ago", int(d.Hours()/24))
	default:
		return t.Format("2006-01-02")
	}
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n-1] + "…"
}
