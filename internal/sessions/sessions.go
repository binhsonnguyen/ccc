// Package sessions discovers Claude Code sessions on disk.
//
// Storage layout (read-only input):
//
//	~/.claude/projects/<encoded-cwd>/
//	  sessions-index.json   (preferred metadata; ~30% of folders)
//	  <uuid>.jsonl          (always present; full transcript)
//
// cwd is resolved per design v4.1 §2 in priority order:
//  1. entry.projectPath in sessions-index.json
//  2. top-level originalPath in the same file
//  3. last cwd field on a user/assistant line in the JSONL
//
// The encoded folder name is never decoded (lossy).
package sessions

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
)

// Session represents a single Claude Code session, ready to display+resume.
type Session struct {
	UUID       string    // Claude session id; resume key
	CWD        string    // working directory; cd target
	Summary    string    // human-readable title
	GitBranch  string    // optional, "" if unknown
	Modified   time.Time // last activity
	IndexPath  string    // path to sessions-index.json (or "" if synthesized)
	JSONLPath  string    // path to <uuid>.jsonl
	Sidechain  bool      // true = subagent session, hidden by default
}

// indexFile mirrors sessions-index.json structure (defensive — unknown fields ignored).
type indexFile struct {
	Version      int           `json:"version"`
	OriginalPath string        `json:"originalPath"`
	Entries      []indexEntry  `json:"entries"`
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

// Scan walks ~/.claude/projects and returns all sessions sorted most-recent-first.
// Sessions whose cwd cannot be resolved are dropped with a stderr warning.
func Scan() ([]Session, error) {
	root, err := projectsRoot()
	if err != nil {
		return nil, err
	}

	dirs, err := os.ReadDir(root)
	if err != nil {
		return nil, fmt.Errorf("read %s: %w", root, err)
	}

	var sessions []Session
	for _, d := range dirs {
		if !d.IsDir() {
			continue
		}
		projectDir := filepath.Join(root, d.Name())
		ss, err := scanProject(projectDir)
		if err != nil {
			fmt.Fprintf(os.Stderr, "c2: skip %s: %v\n", d.Name(), err)
			continue
		}
		sessions = append(sessions, ss...)
	}

	sort.Slice(sessions, func(i, j int) bool {
		return sessions[i].Modified.After(sessions[j].Modified)
	})
	return sessions, nil
}

// projectsRoot returns ~/.claude/projects, honoring $CLAUDE_HOME if set.
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

// scanProject reads one project folder. Prefers sessions-index.json; falls back
// to walking *.jsonl files and synthesizing entries.
func scanProject(dir string) ([]Session, error) {
	indexPath := filepath.Join(dir, "sessions-index.json")
	if idx, err := loadIndex(indexPath); err == nil {
		return sessionsFromIndex(idx, indexPath, dir), nil
	} else if !errors.Is(err, fs.ErrNotExist) {
		// Index exists but is malformed — fall through to JSONL fallback.
		fmt.Fprintf(os.Stderr, "c2: malformed %s: %v\n", indexPath, err)
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

func sessionsFromIndex(idx *indexFile, indexPath, dir string) []Session {
	out := make([]Session, 0, len(idx.Entries))
	for _, e := range idx.Entries {
		cwd := e.ProjectPath
		if cwd == "" {
			cwd = idx.OriginalPath
		}
		jsonlPath := e.FullPath
		if jsonlPath == "" {
			jsonlPath = filepath.Join(dir, e.SessionID+".jsonl")
		}
		// Final fallback: parse JSONL for cwd.
		if cwd == "" {
			cwd = lastCWDFromJSONL(jsonlPath)
		}
		if cwd == "" {
			fmt.Fprintf(os.Stderr, "c2: skip %s: cannot resolve cwd\n", e.SessionID)
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
		out = append(out, Session{
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

// sessionsFromJSONL handles project folders without sessions-index.json.
// Parses each .jsonl just enough to extract cwd + summary.
func sessionsFromJSONL(dir string) ([]Session, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	var out []Session
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".jsonl") {
			continue
		}
		jsonlPath := filepath.Join(dir, e.Name())
		uuid := strings.TrimSuffix(e.Name(), ".jsonl")
		cwd, summary := scanJSONL(jsonlPath)
		if cwd == "" {
			fmt.Fprintf(os.Stderr, "c2: skip %s: no cwd in jsonl\n", uuid)
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue
		}
		out = append(out, Session{
			UUID:      uuid,
			CWD:       cwd,
			Summary:   summary,
			Modified:  info.ModTime(),
			JSONLPath: jsonlPath,
		})
	}
	return out, nil
}

// jsonlLine is the minimal subset we need from any JSONL line.
type jsonlLine struct {
	Type    string          `json:"type"`
	CWD     string          `json:"cwd"`
	Message json.RawMessage `json:"message"`
}

// scanJSONL reads a JSONL once and returns (lastCWD, firstUserPrompt).
// Only user/assistant lines carry cwd (verified — see DESIGN.md §2).
func scanJSONL(path string) (cwd, summary string) {
	f, err := os.Open(path)
	if err != nil {
		return "", ""
	}
	defer f.Close()

	scanner := bufio.NewScanner(f)
	scanner.Buffer(make([]byte, 1<<16), 1<<24) // up to 16MB per line
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

// lastCWDFromJSONL returns only the last cwd, used when index entry lacks it.
func lastCWDFromJSONL(path string) string {
	cwd, _ := scanJSONL(path)
	return cwd
}

// extractText pulls a plaintext snippet from a user message (handles both
// string and structured-content shapes Claude uses).
func extractText(raw json.RawMessage) string {
	// Try shape: {"role":"user","content":"hello"}
	var asStr struct {
		Content string `json:"content"`
	}
	if err := json.Unmarshal(raw, &asStr); err == nil && asStr.Content != "" {
		return strings.TrimSpace(asStr.Content)
	}
	// Try shape: {"role":"user","content":[{"type":"text","text":"hi"}, ...]}
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
