package claudefs

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/binhsonnguyen/ccc/core"
)

type Repo struct{}

func New() *Repo { return &Repo{} }

type indexFile struct {
	Version      int          `json:"version"`
	OriginalPath string       `json:"originalPath"`
	Entries      []indexEntry `json:"entries"`
}

type indexEntry struct {
	SessionID    string `json:"sessionId"`
	FullPath     string `json:"fullPath"`
	FileMtime    int64  `json:"fileMtime"`
	FirstPrompt  string `json:"firstPrompt"`
	Summary      string `json:"summary"`
	MessageCount int    `json:"messageCount"`
	Modified     string `json:"modified"`
	GitBranch    string `json:"gitBranch"`
	ProjectPath  string `json:"projectPath"`
	IsSidechain  bool   `json:"isSidechain"`
}

func (r *Repo) Scan() ([]core.Session, error) {
	root, err := projectsRoot()
	if err != nil {
		return nil, err
	}

	dirs, err := os.ReadDir(root)
	if err != nil {
		return nil, fmt.Errorf("read %s: %w", root, err)
	}

	var sessions []core.Session
	for _, d := range dirs {
		if !d.IsDir() {
			continue
		}
		projectDir := filepath.Join(root, d.Name())
		ss, err := scanProject(projectDir)
		if err != nil {
			fmt.Fprintf(os.Stderr, "c3: skip %s: %v\n", d.Name(), err)
			continue
		}
		sessions = append(sessions, ss...)
	}

	sort.Slice(sessions, func(i, j int) bool {
		return sessions[i].Modified.After(sessions[j].Modified)
	})
	return sessions, nil
}

// ScanProject scans ONLY the Claude project directory corresponding to
// `cwd`, returning sessions found there. Used by the ptymgr discovery
// loop to avoid the full-tree Scan() cost on every tick: a user with
// many projects would otherwise pay O(N projects × full JSONL parse)
// every 500 ms.
//
// Claude encodes project paths by replacing `/`, `.`, and `_` with `-`
// (verified against an actual ~/.claude/projects listing). If the
// encoded dir doesn't exist yet (e.g. claude hasn't written its first
// JSONL for this cwd), returns an empty slice + nil error — the
// discovery loop will retry on the next tick.
func (r *Repo) ScanProject(cwd string) ([]core.Session, error) {
	if cwd == "" {
		return nil, nil
	}
	root, err := projectsRoot()
	if err != nil {
		return nil, err
	}
	dir := filepath.Join(root, encodeCWD(cwd))
	info, err := os.Stat(dir)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if !info.IsDir() {
		return nil, nil
	}
	out, err := scanProject(dir)
	if err != nil {
		return nil, err
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Modified.After(out[j].Modified) })
	return out, nil
}

// encodeCWD mirrors Claude's project-dir naming: any character not in
// [A-Za-z0-9-] becomes `-`. Originally this only replaced /, ., _ but
// that missed spaces (e.g. "Diablo 2"), which the discovery loop then
// looked up under the wrong dir name and left the session stuck in
// "pending" forever. Broadening to "everything not safe" is the safer
// invariant — Claude is unlikely to ever keep a special char as-is in
// a filesystem path on macOS/Linux.
func encodeCWD(cwd string) string {
	var b strings.Builder
	b.Grow(len(cwd))
	for _, r := range cwd {
		if (r >= 'a' && r <= 'z') ||
			(r >= 'A' && r <= 'Z') ||
			(r >= '0' && r <= '9') ||
			r == '-' {
			b.WriteRune(r)
			continue
		}
		b.WriteByte('-')
	}
	return b.String()
}

// Cwds returns deduped recent cwds across all Claude sessions, ordered by
// the most-recent Modified time per cwd. Sidechain sessions are excluded.
// Powers the "New session" cwd picker on both CLI and GUI.
func (r *Repo) Cwds() ([]string, error) {
	sessions, err := r.Scan()
	if err != nil {
		return nil, err
	}
	seen := map[string]bool{}
	var out []string
	for _, s := range sessions {
		if s.Sidechain || s.CWD == "" {
			continue
		}
		if seen[s.CWD] {
			continue
		}
		seen[s.CWD] = true
		out = append(out, s.CWD)
	}
	return out, nil
}

func projectsRoot() (string, error) {
	if h := os.Getenv("CLAUDE_HOME"); h != "" {
		return filepath.Join(h, "projects"), nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".claude", "projects"), nil
}

func scanProject(dir string) ([]core.Session, error) {
	indexPath := filepath.Join(dir, "sessions-index.json")
	if idx, err := loadIndex(indexPath); err == nil {
		return sessionsFromIndex(idx, indexPath, dir), nil
	} else if !errors.Is(err, fs.ErrNotExist) {
		fmt.Fprintf(os.Stderr, "c3: malformed %s: %v\n", indexPath, err)
	}
	return sessionsFromJSONL(dir)
}

func loadIndex(path string) (*indexFile, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var idx indexFile
	if err := json.Unmarshal(b, &idx); err != nil {
		return nil, fmt.Errorf("unmarshal: %w", err)
	}
	return &idx, nil
}

func sessionsFromIndex(idx *indexFile, indexPath, dir string) []core.Session {
	out := make([]core.Session, 0, len(idx.Entries))
	for _, e := range idx.Entries {
		cwd := e.ProjectPath
		if cwd == "" {
			cwd = idx.OriginalPath
		}
		jsonlPath := e.FullPath
		if jsonlPath == "" {
			jsonlPath = filepath.Join(dir, e.SessionID+".jsonl")
		}
		if cwd == "" {
			cwd = lastCWDFromJSONL(jsonlPath)
		}
		if cwd == "" {
			fmt.Fprintf(os.Stderr, "c3: skip %s: cannot resolve cwd\n", e.SessionID)
			continue
		}
		modified := parseTime(e.Modified)
		if modified.IsZero() && e.FileMtime > 0 {
			modified = time.UnixMilli(e.FileMtime)
		}
		summary := e.Summary
		if summary == "" {
			summary = strings.TrimSpace(e.FirstPrompt)
		}
		out = append(out, core.Session{
			UUID:      e.SessionID,
			CWD:       cwd,
			Summary:   summary,
			GitBranch: e.GitBranch,
			Modified:  modified,
			IndexPath: indexPath,
			JSONLPath: jsonlPath,
			Sidechain: e.IsSidechain,
		})
	}
	return out
}

func sessionsFromJSONL(dir string) ([]core.Session, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	var out []core.Session
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".jsonl") {
			continue
		}
		jsonlPath := filepath.Join(dir, e.Name())
		uuid := strings.TrimSuffix(e.Name(), ".jsonl")
		cwd, summary := scanJSONL(jsonlPath)
		if cwd == "" {
			fmt.Fprintf(os.Stderr, "c3: skip %s: no cwd in jsonl\n", uuid)
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue
		}
		out = append(out, core.Session{
			UUID:      uuid,
			CWD:       cwd,
			Summary:   summary,
			Modified:  info.ModTime(),
			JSONLPath: jsonlPath,
		})
	}
	return out, nil
}

type jsonlLine struct {
	Type    string          `json:"type"`
	CWD     string          `json:"cwd"`
	Message json.RawMessage `json:"message"`
}

func scanJSONL(path string) (cwd, summary string) {
	f, err := os.Open(path)
	if err != nil {
		return "", ""
	}
	defer f.Close()

	scanner := bufio.NewScanner(f)
	scanner.Buffer(make([]byte, 1<<16), 1<<24)
	for scanner.Scan() {
		var line jsonlLine
		if err := json.Unmarshal(scanner.Bytes(), &line); err != nil {
			continue
		}
		if line.Type != "user" && line.Type != "assistant" {
			continue
		}
		if line.CWD != "" {
			cwd = line.CWD
		}
		if summary == "" && line.Type == "user" && len(line.Message) > 0 {
			summary = extractText(line.Message)
		}
	}
	return cwd, truncate(summary, 80)
}

func lastCWDFromJSONL(path string) string {
	cwd, _ := scanJSONL(path)
	return cwd
}

func extractText(raw json.RawMessage) string {
	var asStr struct {
		Content string `json:"content"`
	}
	if err := json.Unmarshal(raw, &asStr); err == nil && asStr.Content != "" {
		return strings.TrimSpace(asStr.Content)
	}
	var asArr struct {
		Content []struct {
			Type string `json:"type"`
			Text string `json:"text"`
		} `json:"content"`
	}
	if err := json.Unmarshal(raw, &asArr); err == nil {
		for _, c := range asArr.Content {
			if c.Type == "text" && c.Text != "" {
				return strings.TrimSpace(c.Text)
			}
		}
	}
	return ""
}

func parseTime(s string) time.Time {
	if s == "" {
		return time.Time{}
	}
	t, err := time.Parse(time.RFC3339, s)
	if err != nil {
		return time.Time{}
	}
	return t
}

func truncate(s string, n int) string {
	s = strings.ReplaceAll(s, "\n", " ")
	if len(s) <= n {
		return s
	}
	return s[:n-1] + "…"
}
