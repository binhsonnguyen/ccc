package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/binhsonnguyen/ccc/adapters/archivejson"
	"github.com/binhsonnguyen/ccc/core"
)

// Shell entries (Kind == "shell") must NEVER be auto-bound by lazyLink,
// even when the cwd is claude-active. A user who opened a shell tab in a
// project that also runs claude would otherwise see their shell suddenly
// "adopt" the next JSONL claude writes there — visible as a claudeUuid
// appearing on the shell row in the sidebar. Test by seeding a shell
// entry whose cwd matches a claude JSONL written AFTER its CreatedAt
// (the only condition under which lazyLink considers a match) and
// asserting ClaudeUUID stays empty.
func TestLazyLink_SkipsShellEntries(t *testing.T) {
	// Isolate XDG so the test never touches the user's real archive.
	xdg := t.TempDir()
	t.Setenv("XDG_DATA_HOME", xdg)

	// Seed an "active" claude JSONL under ~/.claude/projects/<encoded>.
	// claudefs.Scan() encodes cwd as "-" separated absolute path with
	// '/' → '-' substitution. Use a cwd that's a real existing dir so
	// the rest of the path resolution works.
	cwd := t.TempDir()
	home := t.TempDir()
	t.Setenv("HOME", home)
	encoded := encodeCWD(cwd)
	projDir := filepath.Join(home, ".claude", "projects", encoded)
	if err := os.MkdirAll(projDir, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	// Single-event JSONL with a cwd-bearing record. claudefs's parser
	// reads `cwd` and `sessionId` from any line.
	uuid := "00000000-0000-0000-0000-000000000abc"
	line := map[string]any{
		"sessionId": uuid,
		"cwd":       cwd,
		"type":      "user",
	}
	b, _ := json.Marshal(line)
	jsonlPath := filepath.Join(projDir, uuid+".jsonl")
	if err := os.WriteFile(jsonlPath, append(b, '\n'), 0o644); err != nil {
		t.Fatalf("write jsonl: %v", err)
	}
	// Make sure JSONL mtime is AFTER any entry's CreatedAt. lazyLink
	// requires `s.Modified.After(e.CreatedAt)` to consider a candidate.
	future := time.Now().Add(time.Hour)
	if err := os.Chtimes(jsonlPath, future, future); err != nil {
		t.Fatalf("chtimes: %v", err)
	}

	// Seed the archive with a SHELL entry whose cwd matches the JSONL's cwd.
	// Use the package-level `store` (already initialised) — it picks up
	// XDG_DATA_HOME each call.
	store = archivejson.New()
	if err := store.Mutate(func(f *core.ArchiveFile) error {
		_ = f.AddShellEntry("shell-tab", cwd, nil)
		return nil
	}); err != nil {
		t.Fatalf("seed shell entry: %v", err)
	}

	// Run lazyLink — must NOT bind the shell entry.
	if err := lazyLink(); err != nil {
		t.Fatalf("lazyLink: %v", err)
	}

	f, err := store.Load()
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if len(f.Sessions) != 1 {
		t.Fatalf("expected 1 entry, got %d", len(f.Sessions))
	}
	got := f.Sessions[0]
	if !got.IsShell() {
		t.Errorf("entry lost shell kind: %+v", got)
	}
	if got.ClaudeUUID != "" {
		t.Errorf("shell entry was bound to claude uuid %q; want empty", got.ClaudeUUID)
	}
}

// encodeCWD mirrors adapters/claudefs.encodeCWD: any char not in
// [A-Za-z0-9-] becomes '-'. Replicated here so this test stays
// adapter-internal-free (and to catch any future drift between the two).
func encodeCWD(cwd string) string {
	out := make([]rune, 0, len(cwd))
	for _, r := range cwd {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '-' {
			out = append(out, r)
			continue
		}
		out = append(out, '-')
	}
	return string(out)
}
