package claudefs

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
	"unicode/utf8"
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

// TestBuildSnippetUTF8Boundary verifies the snippet window snaps to
// rune boundaries, never producing U+FFFD on Vietnamese / CJK / emoji
// characters that straddle the byte cut.
func TestBuildSnippetUTF8Boundary(t *testing.T) {
	// 'ầ' is 3 bytes in UTF-8 (0xE1 0xBA 0xA7). Pad with enough copies
	// so the snippet cut at radius=30 bytes lands mid-rune.
	pad := strings.Repeat("ầ", 20) // 60 bytes of multi-byte chars
	line := pad + "NEEDLE" + pad
	idx := strings.Index(line, "NEEDLE")
	s := buildSnippet(line, idx, len("NEEDLE"))
	if !utf8.ValidString(s) {
		t.Errorf("snippet not valid UTF-8: %q", s)
	}
	if strings.ContainsRune(s, '�') {
		t.Errorf("snippet contains replacement char: %q", s)
	}
	if !strings.Contains(s, "NEEDLE") {
		t.Errorf("snippet missing needle: %q", s)
	}

	// Match at start of line — start clamp.
	line2 := "NEEDLE" + pad
	s2 := buildSnippet(line2, 0, len("NEEDLE"))
	if !utf8.ValidString(s2) || strings.ContainsRune(s2, '�') {
		t.Errorf("start-clamp snippet broken: %q", s2)
	}

	// Match at end of line — end clamp.
	line3 := pad + "NEEDLE"
	s3 := buildSnippet(line3, strings.Index(line3, "NEEDLE"), len("NEEDLE"))
	if !utf8.ValidString(s3) || strings.ContainsRune(s3, '�') {
		t.Errorf("end-clamp snippet broken: %q", s3)
	}

	// Match spanning a 4-byte emoji.
	line4 := pad + "🔥NEEDLE🔥" + pad
	idx4 := strings.Index(line4, "NEEDLE")
	s4 := buildSnippet(line4, idx4, len("NEEDLE"))
	if !utf8.ValidString(s4) || strings.ContainsRune(s4, '�') {
		t.Errorf("emoji-adjacent snippet broken: %q", s4)
	}
}

// TestSearchTruncation seeds limit+5 matching JSONLs and asserts the
// early-break preserves mtime-desc ordering: the returned UUIDs must
// be the `limit` most-recently-modified ones.
func TestSearchTruncation(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("CLAUDE_HOME", tmp)
	projDir := filepath.Join(tmp, "projects", "-Users-test-proj")
	if err := os.MkdirAll(projDir, 0o755); err != nil {
		t.Fatal(err)
	}
	const limit = 3
	const total = limit + 5

	// Write `total` matching files with mtimes spaced 1s apart so file N
	// is older than file N+1. The most-recent `limit` should win.
	for i := 0; i < total; i++ {
		uuid := fmt.Sprintf("%08d-0000-0000-0000-000000000000", i)
		path := filepath.Join(projDir, uuid+".jsonl")
		body := `{"type":"user","cwd":"/Users/test/proj","message":{"content":"the needle is here"}}` + "\n"
		if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
		mtime := time.Now().Add(time.Duration(i) * time.Second)
		if err := os.Chtimes(path, mtime, mtime); err != nil {
			t.Fatal(err)
		}
	}

	r := New()
	matches, truncated, err := r.Search("needle", limit)
	if err != nil {
		t.Fatalf("Search: %v", err)
	}
	if !truncated {
		t.Errorf("expected truncated=true, got false")
	}
	if len(matches) != limit {
		t.Fatalf("want %d matches, got %d", limit, len(matches))
	}
	// Most-recent `limit` are uuids (total-1) down to (total-limit).
	for i, m := range matches {
		wantIdx := total - 1 - i
		wantUUID := fmt.Sprintf("%08d-0000-0000-0000-000000000000", wantIdx)
		if m.ClaudeUUID != wantUUID {
			t.Errorf("match[%d]: want uuid %s, got %s", i, wantUUID, m.ClaudeUUID)
		}
	}
}

// TestSearchExactLimit: limit matches exactly → truncated=false.
func TestSearchExactLimit(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("CLAUDE_HOME", tmp)
	projDir := filepath.Join(tmp, "projects", "-Users-test-proj")
	if err := os.MkdirAll(projDir, 0o755); err != nil {
		t.Fatal(err)
	}
	const limit = 3
	for i := 0; i < limit; i++ {
		uuid := fmt.Sprintf("%08d-0000-0000-0000-000000000000", i)
		path := filepath.Join(projDir, uuid+".jsonl")
		if err := os.WriteFile(path, []byte(
			`{"type":"user","cwd":"/Users/test/proj","message":{"content":"the needle is here"}}`+"\n"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	r := New()
	matches, truncated, err := r.Search("needle", limit)
	if err != nil {
		t.Fatalf("Search: %v", err)
	}
	if truncated {
		t.Errorf("exactly-limit matches: want truncated=false, got true")
	}
	if len(matches) != limit {
		t.Errorf("want %d matches, got %d", limit, len(matches))
	}
}
