package ptyrunner

import (
	"strings"
	"testing"
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
