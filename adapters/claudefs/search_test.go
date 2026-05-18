package claudefs

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestSearch covers the happy path (one match in one file out of two)
// plus the query-too-short error path. Synthesizes ~/.claude/projects
// inside a temp dir and points CLAUDE_HOME at it.
func TestSearch(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("CLAUDE_HOME", tmp)

	projDir := filepath.Join(tmp, "projects", "-Users-test-proj")
	if err := os.MkdirAll(projDir, 0o755); err != nil {
		t.Fatal(err)
	}
	// One file with the needle, one without.
	hit := filepath.Join(projDir, "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.jsonl")
	if err := os.WriteFile(hit, []byte(
		`{"type":"user","cwd":"/Users/test/proj","message":{"content":"hello world"}}`+"\n"+
			`{"type":"assistant","cwd":"/Users/test/proj","message":{"content":[{"type":"text","text":"goroutine panic happened here"}]}}`+"\n",
	), 0o644); err != nil {
		t.Fatal(err)
	}
	miss := filepath.Join(projDir, "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb.jsonl")
	if err := os.WriteFile(miss, []byte(
		`{"type":"user","cwd":"/Users/test/proj","message":{"content":"nothing of interest"}}`+"\n",
	), 0o644); err != nil {
		t.Fatal(err)
	}

	r := New()
	matches, truncated, err := r.Search("panic", 20)
	if err != nil {
		t.Fatalf("Search: %v", err)
	}
	if truncated {
		t.Errorf("expected truncated=false, got true")
	}
	if len(matches) != 1 {
		t.Fatalf("want 1 match, got %d: %+v", len(matches), matches)
	}
	if !strings.Contains(matches[0].Snippet, "panic") {
		t.Errorf("snippet missing needle: %q", matches[0].Snippet)
	}
	if matches[0].ClaudeUUID != "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" {
		t.Errorf("wrong uuid: %s", matches[0].ClaudeUUID)
	}

	// Case-insensitivity.
	matches, _, err = r.Search("PANIC", 20)
	if err != nil || len(matches) != 1 {
		t.Errorf("case-insensitive match failed: matches=%d err=%v", len(matches), err)
	}

	// Too-short query.
	_, _, err = r.Search("ab", 20)
	if _, ok := err.(ErrQueryTooShort); !ok {
		t.Errorf("expected ErrQueryTooShort, got %v", err)
	}
}

func TestBuildSnippet(t *testing.T) {
	line := strings.Repeat("x", 100) + "NEEDLE" + strings.Repeat("y", 100)
	s := buildSnippet(line, 100, len("NEEDLE"))
	if !strings.Contains(s, "NEEDLE") {
		t.Errorf("snippet missing needle: %q", s)
	}
	if !strings.HasPrefix(s, "…") || !strings.HasSuffix(s, "…") {
		t.Errorf("expected ellipses on both sides: %q", s)
	}
}
