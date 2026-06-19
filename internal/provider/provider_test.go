package provider

import (
	"os"
	"path/filepath"
	"testing"
)

// withTempData points the data-dir helpers at a temp dir via XDG_DATA_HOME
// so tests never touch the real ~/.local/share/c3.
func withTempData(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	t.Setenv("XDG_DATA_HOME", dir)
	return filepath.Join(dir, "c3")
}

func TestOverlay_PassthroughWhenNoActive(t *testing.T) {
	withTempData(t)
	s := New()
	if ov := s.Overlay(); ov != nil {
		t.Fatalf("expected nil overlay for default (no active) config, got %v", ov)
	}
}

func TestOverlay_DeepSeekInjectsAndStripsNothingExtra(t *testing.T) {
	withTempData(t)
	s := New()
	if err := s.SetToken("deepseek", "sk-test-123"); err != nil {
		t.Fatal(err)
	}
	if err := s.SetActive("deepseek"); err != nil {
		t.Fatal(err)
	}
	ov := s.Overlay()
	if ov["ANTHROPIC_BASE_URL"] != "https://api.deepseek.com/anthropic" {
		t.Errorf("base url = %q", ov["ANTHROPIC_BASE_URL"])
	}
	if ov["ANTHROPIC_AUTH_TOKEN"] != "sk-test-123" {
		t.Errorf("token = %q", ov["ANTHROPIC_AUTH_TOKEN"])
	}
	if ov["ANTHROPIC_MODEL"] != "deepseek-v4-pro[1m]" {
		t.Errorf("model = %q", ov["ANTHROPIC_MODEL"])
	}
}

// Switching to Anthropic (which defines no env) must CLEAR every key DeepSeek
// manages, so a stale DeepSeek var from the shell rc can't bleed through.
func TestOverlay_AnthropicClearsDeepSeekKeys(t *testing.T) {
	withTempData(t)
	s := New()
	if err := s.SetActive("anthropic"); err != nil {
		t.Fatal(err)
	}
	ov := s.Overlay()
	for _, k := range []string{
		"ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_MODEL",
		"ANTHROPIC_DEFAULT_OPUS_MODEL", "CLAUDE_CODE_SUBAGENT_MODEL",
		"CLAUDE_CODE_EFFORT_LEVEL",
	} {
		v, ok := ov[k]
		if !ok {
			t.Errorf("expected %s present (as clear), missing", k)
		}
		if v != "" {
			t.Errorf("expected %s cleared, got %q", k, v)
		}
	}
}

func TestSetToken_PersistsWith0600AndHasToken(t *testing.T) {
	root := withTempData(t)
	s := New()
	if err := s.SetToken("deepseek", "sk-abc"); err != nil {
		t.Fatal(err)
	}
	has, err := s.HasToken("deepseek")
	if err != nil || !has {
		t.Fatalf("HasToken = %v, %v; want true, nil", has, err)
	}
	info, err := os.Stat(filepath.Join(root, "secrets.json"))
	if err != nil {
		t.Fatal(err)
	}
	if perm := info.Mode().Perm(); perm != 0o600 {
		t.Errorf("secrets.json perm = %o, want 600", perm)
	}
	// Clearing removes it.
	if err := s.SetToken("deepseek", ""); err != nil {
		t.Fatal(err)
	}
	if has, _ := s.HasToken("deepseek"); has {
		t.Error("expected token cleared")
	}
}

func TestSetActive_RejectsUnknownProfile(t *testing.T) {
	withTempData(t)
	s := New()
	if err := s.SetActive("nope"); err == nil {
		t.Fatal("expected error for unknown profile")
	}
	// Empty is allowed (passthrough).
	if err := s.SetActive(""); err != nil {
		t.Fatalf("empty active should be allowed: %v", err)
	}
}
