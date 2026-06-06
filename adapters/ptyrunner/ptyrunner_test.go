package ptyrunner

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestAugmentPath_NoPathInEnv(t *testing.T) {
	env := []string{"FOO=bar"}
	got := augmentPath(env)
	var pathLine string
	for _, kv := range got {
		if strings.HasPrefix(kv, "PATH=") {
			pathLine = kv
			break
		}
	}
	if pathLine == "" {
		t.Fatalf("augmentPath did not add a PATH entry; env=%v", got)
	}
	// At least one fallback dir should be present.
	if !strings.Contains(pathLine, "/.local/bin") && !strings.Contains(pathLine, "/opt/homebrew/bin") {
		t.Fatalf("PATH lacks expected fallback dirs: %s", pathLine)
	}
}

func TestAugmentPath_PreservesExistingPath(t *testing.T) {
	env := []string{"PATH=/usr/bin:/bin", "FOO=bar"}
	got := augmentPath(env)
	var pathLine string
	pathLines := 0
	for _, kv := range got {
		if strings.HasPrefix(kv, "PATH=") {
			pathLine = kv
			pathLines++
		}
	}
	if pathLines != 1 {
		t.Fatalf("expected exactly one PATH entry, got %d: %v", pathLines, got)
	}
	// Original entries must still be there.
	if !strings.HasSuffix(pathLine, ":/usr/bin:/bin") {
		t.Fatalf("PATH should end with original path; got %s", pathLine)
	}
}

// StartShell must not touch ~/.claude/projects/. We point HOME at a temp
// dir, pre-seed it with a fake project tree (so we'd notice anything
// new), spawn a shell briefly, then snapshot the directory listing. The
// only file allowed to appear is the pre-existing one.
func TestStartShell_DoesNotCreateClaudeJSONL(t *testing.T) {
	// Use a temp HOME so the test never touches the user's real
	// ~/.claude/projects/. resolveClaude / augmentPath read HOME via
	// fallbackBinDirs, which is fine — they only build PATH entries.
	tmpHome := t.TempDir()
	t.Setenv("HOME", tmpHome)

	projectsDir := filepath.Join(tmpHome, ".claude", "projects", "encoded-cwd")
	if err := os.MkdirAll(projectsDir, 0o755); err != nil {
		t.Fatalf("mkdir projects: %v", err)
	}
	preExisting := filepath.Join(projectsDir, "pre-existing.jsonl")
	if err := os.WriteFile(preExisting, []byte("{}\n"), 0o644); err != nil {
		t.Fatalf("seed jsonl: %v", err)
	}

	cwd := t.TempDir()
	// argv = nil → default ($SHELL or /bin/bash -i). We force /bin/sh so
	// the test doesn't depend on the developer's login shell being
	// installed under HOME=tmp.
	sess, err := StartShell(cwd, []string{"/bin/sh", "-c", "echo hello"})
	if err != nil {
		t.Skipf("StartShell unavailable in this environment: %v", err)
		return
	}
	// Drain briefly and let the child exit on its own.
	go func() {
		buf := make([]byte, 1024)
		for {
			if _, err := sess.Master.Read(buf); err != nil {
				return
			}
		}
	}()
	time.Sleep(200 * time.Millisecond)
	_ = sess.Kill()
	_, _ = sess.Wait()

	// Walk ~/.claude/projects and assert only the pre-existing file is there.
	var found []string
	root := filepath.Join(tmpHome, ".claude", "projects")
	if err := filepath.Walk(root, func(p string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		if info.IsDir() {
			return nil
		}
		found = append(found, p)
		return nil
	}); err != nil {
		t.Fatalf("walk: %v", err)
	}
	if len(found) != 1 || found[0] != preExisting {
		t.Fatalf("unexpected files under ~/.claude/projects: %v", found)
	}
}

func localeLines(env []string) []string {
	var out []string
	for _, kv := range env {
		if strings.HasPrefix(kv, "LANG=") ||
			strings.HasPrefix(kv, "LC_ALL=") ||
			strings.HasPrefix(kv, "LC_CTYPE=") {
			out = append(out, kv)
		}
	}
	return out
}

// The launchd bug: empty/absent locale → inject a UTF-8 LANG so children
// don't fall back to Mac Roman and mangle Vietnamese text.
func TestEnsureUTF8Locale_InjectsWhenAbsent(t *testing.T) {
	got := ensureUTF8Locale([]string{"FOO=bar"})
	lines := localeLines(got)
	if len(lines) != 1 || lines[0] != "LANG=en_US.UTF-8" {
		t.Fatalf("expected LANG=en_US.UTF-8 injected, got %v", lines)
	}
}

// An empty LANG= (what we actually measured under launchd) counts as
// unset and must still get the UTF-8 default.
func TestEnsureUTF8Locale_InjectsWhenEmpty(t *testing.T) {
	got := ensureUTF8Locale([]string{"LANG=", "LC_ALL=", "LC_CTYPE="})
	found := false
	for _, kv := range got {
		if kv == "LANG=en_US.UTF-8" {
			found = true
		}
	}
	if !found {
		t.Fatalf("expected LANG=en_US.UTF-8 injected for empty locale; got %v", localeLines(got))
	}
}

// A user who already set a UTF-8 locale (or any locale at all) must be
// left untouched — we never override an explicit choice.
func TestEnsureUTF8Locale_RespectsExisting(t *testing.T) {
	for _, existing := range []string{"LANG=vi_VN.UTF-8", "LC_CTYPE=en_GB.UTF-8", "LC_ALL=C"} {
		got := ensureUTF8Locale([]string{existing, "FOO=bar"})
		lines := localeLines(got)
		if len(lines) != 1 || lines[0] != existing {
			t.Fatalf("ensureUTF8Locale altered explicit locale %q: %v", existing, lines)
		}
	}
}

func TestParseEnv0(t *testing.T) {
	// NUL-delimited, with a value that itself contains a newline.
	raw := []byte("PATH=/usr/bin:/bin\x00LANG=en_US.UTF-8\x00MULTI=line1\nline2\x00")
	got := parseEnv0(raw)
	want := []string{"PATH=/usr/bin:/bin", "LANG=en_US.UTF-8", "MULTI=line1\nline2"}
	if len(got) != len(want) {
		t.Fatalf("parseEnv0 len=%d want %d: %v", len(got), len(want), got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("parseEnv0[%d]=%q want %q", i, got[i], want[i])
		}
	}
}

func TestParseEnv0_DropsMalformed(t *testing.T) {
	// Empty segments, a no-'=' token, and a leading-'=' token must all drop.
	raw := []byte("\x00noequals\x00=novalue\x00OK=1\x00")
	got := parseEnv0(raw)
	if len(got) != 1 || got[0] != "OK=1" {
		t.Fatalf("expected only OK=1, got %v", got)
	}
}

func TestParseEnv0_EmptyReturnsNil(t *testing.T) {
	if got := parseEnv0(nil); got != nil {
		t.Fatalf("expected nil for empty input, got %v", got)
	}
}

func TestSetEnv_ReplacesAndAppends(t *testing.T) {
	env := []string{"A=1", "TERM=dumb", "B=2"}
	got := setEnv(env, "TERM", "xterm-256color")
	found := ""
	count := 0
	for _, kv := range got {
		if strings.HasPrefix(kv, "TERM=") {
			found = kv
			count++
		}
	}
	if count != 1 || found != "TERM=xterm-256color" {
		t.Fatalf("setEnv replace: count=%d found=%q", count, found)
	}
	// setEnv must not mutate the caller's slice.
	if env[1] != "TERM=dumb" {
		t.Fatalf("setEnv mutated input: %v", env)
	}
	got2 := setEnv([]string{"A=1"}, "TERM", "x")
	if got2[len(got2)-1] != "TERM=x" {
		t.Fatalf("setEnv append: %v", got2)
	}
}

// buildChildEnv must always force TERM and guarantee a UTF-8 locale +
// augmented PATH regardless of how thin the base env is.
func TestBuildChildEnv_ForcesTermAndLocale(t *testing.T) {
	got := buildChildEnv([]string{"TERM=dumb"})
	var term, lang, path string
	for _, kv := range got {
		switch {
		case strings.HasPrefix(kv, "TERM="):
			term = kv
		case strings.HasPrefix(kv, "LANG="):
			lang = kv
		case strings.HasPrefix(kv, "PATH="):
			path = kv
		}
	}
	if term != "TERM=xterm-256color" {
		t.Fatalf("TERM not forced: %q", term)
	}
	if lang != "LANG=en_US.UTF-8" {
		t.Fatalf("LANG not ensured: %q", lang)
	}
	if path == "" {
		t.Fatalf("PATH not augmented; env=%v", got)
	}
}

// A login env that already carries a UTF-8 locale must be preserved.
func TestBuildChildEnv_PreservesExistingLocale(t *testing.T) {
	got := buildChildEnv([]string{"LANG=vi_VN.UTF-8", "PATH=/usr/bin"})
	for _, kv := range got {
		if strings.HasPrefix(kv, "LANG=") && kv != "LANG=vi_VN.UTF-8" {
			t.Fatalf("overrode existing LANG: %q", kv)
		}
	}
}

func TestAugmentPath_NoDuplicates(t *testing.T) {
	env := []string{"PATH=/opt/homebrew/bin:/usr/bin"}
	got := augmentPath(env)
	for _, kv := range got {
		if !strings.HasPrefix(kv, "PATH=") {
			continue
		}
		// /opt/homebrew/bin should appear exactly once.
		if count := strings.Count(kv, "/opt/homebrew/bin"); count != 1 {
			t.Fatalf("/opt/homebrew/bin appears %d times in PATH: %s", count, kv)
		}
	}
}
