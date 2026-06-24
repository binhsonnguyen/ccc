package envset

import (
	"os"
	"path/filepath"
	"testing"
)

func withTempData(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	t.Setenv("XDG_DATA_HOME", dir)
	return filepath.Join(dir, "c3")
}

func TestGlobalOverlay_PassthroughWhenNoneActive(t *testing.T) {
	withTempData(t)
	s := New()
	if ov := s.GlobalOverlay(); ov != nil {
		t.Fatalf("expected nil overlay when no set active, got %v", ov)
	}
}

func TestDeepSeekSet_InjectsBearerAndUnsetsApiKey(t *testing.T) {
	withTempData(t)
	s := New()
	if err := s.SetSecret("deepseek", "ANTHROPIC_AUTH_TOKEN", "sk-deep"); err != nil {
		t.Fatal(err)
	}
	if err := s.SetActive([]string{"deepseek"}); err != nil {
		t.Fatal(err)
	}
	ops := s.GlobalOverlay()
	var gotToken, gotBase string
	var apiKeyUnset, oauthUnset bool
	for _, op := range ops {
		switch op.Key {
		case "ANTHROPIC_AUTH_TOKEN":
			gotToken = op.Value
		case "ANTHROPIC_BASE_URL":
			gotBase = op.Value
		case "ANTHROPIC_API_KEY":
			apiKeyUnset = op.Unset
		case "CLAUDE_CODE_OAUTH_TOKEN":
			oauthUnset = op.Unset
		}
	}
	if gotToken != "sk-deep" {
		t.Errorf("AUTH_TOKEN = %q, want sk-deep", gotToken)
	}
	if gotBase != "https://api.deepseek.com/anthropic" {
		t.Errorf("BASE_URL = %q", gotBase)
	}
	if !apiKeyUnset {
		t.Error("ANTHROPIC_API_KEY should be unset")
	}
	if !oauthUnset {
		t.Error("CLAUDE_CODE_OAUTH_TOKEN should be unset")
	}
}

// An unconfigured secret produces no op (must not clobber an inherited value
// with an empty string).
func TestUnconfiguredSecret_Skipped(t *testing.T) {
	withTempData(t)
	s := New()
	if err := s.SetActive([]string{"deepseek"}); err != nil {
		t.Fatal(err)
	}
	for _, op := range s.GlobalOverlay() {
		if op.Key == "ANTHROPIC_AUTH_TOKEN" {
			t.Fatalf("unconfigured secret produced an op: %+v", op)
		}
	}
}

// Per-session Resolve layers after global; later ops win at apply time, which
// we approximate here by checking order: a session set's op comes after the
// global ones in the combined sequence the server builds (global overlay then
// spec.Env). Here we just assert Resolve returns the session set's ops.
func TestResolve_PerSession(t *testing.T) {
	withTempData(t)
	s := New()
	if err := s.UpsertSet("proxy", Set{Label: "Proxy", Vars: []Var{
		{Key: "HTTPS_PROXY", Value: "http://127.0.0.1:8080"},
	}}); err != nil {
		t.Fatal(err)
	}
	ops := s.Resolve([]string{"proxy"})
	if len(ops) != 1 || ops[0].Key != "HTTPS_PROXY" || ops[0].Value != "http://127.0.0.1:8080" {
		t.Fatalf("unexpected ops: %+v", ops)
	}
	if s.Resolve(nil) != nil {
		t.Error("nil ids should resolve to nil")
	}
}

func TestSetSecret_RejectsNonSecretKeyAndPersists0600(t *testing.T) {
	root := withTempData(t)
	s := New()
	// ANTHROPIC_BASE_URL is a plain var in deepseek, not a secret.
	if err := s.SetSecret("deepseek", "ANTHROPIC_BASE_URL", "x"); err == nil {
		t.Fatal("expected rejection setting a non-secret key as secret")
	}
	if err := s.SetSecret("deepseek", "ANTHROPIC_AUTH_TOKEN", "sk-1"); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(filepath.Join(root, "envsecrets.json"))
	if err != nil {
		t.Fatal(err)
	}
	if perm := info.Mode().Perm(); perm != 0o600 {
		t.Errorf("envsecrets.json perm = %o, want 600", perm)
	}
}

func TestSetActive_RejectsUnknown(t *testing.T) {
	withTempData(t)
	s := New()
	if err := s.SetActive([]string{"ghost"}); err == nil {
		t.Fatal("expected error for unknown set")
	}
	if err := s.SetActive(nil); err != nil {
		t.Fatalf("clearing active should be allowed: %v", err)
	}
}

func TestView_MasksSecrets(t *testing.T) {
	withTempData(t)
	s := New()
	if err := s.SetSecret("deepseek", "ANTHROPIC_AUTH_TOKEN", "sk-secret"); err != nil {
		t.Fatal(err)
	}
	v, err := s.View()
	if err != nil {
		t.Fatal(err)
	}
	for _, set := range v.Sets {
		if set.ID != "deepseek" {
			continue
		}
		for _, vv := range set.Vars {
			if vv.Key == "ANTHROPIC_AUTH_TOKEN" {
				if vv.Value != "" {
					t.Errorf("secret value leaked in view: %q", vv.Value)
				}
				if !vv.HasValue {
					t.Error("hasValue should be true")
				}
			}
		}
	}
}

func TestMigrate_ImportsOldFlatTokens(t *testing.T) {
	root := withTempData(t)
	if err := os.MkdirAll(root, 0o755); err != nil {
		t.Fatal(err)
	}
	// Seed an old flat secrets.json (provider-era).
	if err := os.WriteFile(filepath.Join(root, "secrets.json"),
		[]byte(`{"deepseek":"sk-old","anthropic":"oauth-old"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	s := New()
	if err := s.Migrate(); err != nil {
		t.Fatal(err)
	}
	if has, _ := s.HasToken("deepseek", "ANTHROPIC_AUTH_TOKEN"); !has {
		t.Error("deepseek token not imported")
	}
	if has, _ := s.HasToken("anthropic", "CLAUDE_CODE_OAUTH_TOKEN"); !has {
		t.Error("anthropic token not imported")
	}
	// Idempotent: second run no-ops (envsets.json now exists).
	if err := s.Migrate(); err != nil {
		t.Fatal(err)
	}
}
