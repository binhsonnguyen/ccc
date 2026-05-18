package usecase

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/binhsonnguyen/ccc/core"
)

// memStore is an in-memory ArchiveStore for use-case tests. Mutate serializes
// writes via a mutex; that's the only invariant Mutate is required to keep.
type memStore struct {
	mu sync.Mutex
	f  *core.ArchiveFile
}

func newMemStore(entries ...core.C3Entry) *memStore {
	return &memStore{f: &core.ArchiveFile{Version: core.CurrentVersion, Sessions: entries}}
}

func (m *memStore) Load() (*core.ArchiveFile, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	cp := *m.f
	cp.Sessions = append([]core.C3Entry(nil), m.f.Sessions...)
	cp.Archived = append([]string(nil), m.f.Archived...)
	return &cp, nil
}

func (m *memStore) Save(f *core.ArchiveFile) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	cp := *f
	cp.Sessions = append([]core.C3Entry(nil), f.Sessions...)
	cp.Archived = append([]string(nil), f.Archived...)
	m.f = &cp
	return nil
}

func (m *memStore) Mutate(fn func(*core.ArchiveFile) error) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	cp := *m.f
	cp.Sessions = append([]core.C3Entry(nil), m.f.Sessions...)
	cp.Archived = append([]string(nil), m.f.Archived...)
	if err := fn(&cp); err != nil {
		return err
	}
	m.f = &cp
	return nil
}

// fakeSessionsView is a stub for core.SessionsView used to drive the
// Remove "live PTY" branch without standing up a real ptymgr.
type fakeSessionsView struct {
	live   map[string]bool
	killed []string
}

func (f *fakeSessionsView) HasUUID(u string) bool { return f.live[u] }
func (f *fakeSessionsView) KillUUID(u string)     { f.killed = append(f.killed, u); delete(f.live, u) }
func (f *fakeSessionsView) HasKey(k string) bool  { return f.live[k] }
func (f *fakeSessionsView) KillKey(k string)      { f.killed = append(f.killed, k); delete(f.live, k) }

// ---------------------------------------------------------------------------
// Rename
// ---------------------------------------------------------------------------

func TestRename_HappyPath(t *testing.T) {
	s := newMemStore(core.C3Entry{ID: "abc", Name: "old", CreatedAt: time.Now()})
	e, err := Rename(s, "abc", "new name")
	if err != nil {
		t.Fatalf("Rename: %v", err)
	}
	if e.Name != "new name" {
		t.Errorf("Name = %q, want 'new name'", e.Name)
	}
	// Verify persisted.
	f, _ := s.Load()
	if f.Find("abc").Name != "new name" {
		t.Errorf("not persisted")
	}
}

func TestRename_EmptyName(t *testing.T) {
	s := newMemStore(core.C3Entry{ID: "abc", Name: "old"})
	_, err := Rename(s, "abc", "")
	if !errors.Is(err, ErrValidation) {
		t.Errorf("err = %v, want ErrValidation", err)
	}
}

func TestRename_TooLong(t *testing.T) {
	s := newMemStore(core.C3Entry{ID: "abc", Name: "old"})
	_, err := Rename(s, "abc", strings.Repeat("x", MaxNameLen+1))
	if !errors.Is(err, ErrValidation) {
		t.Errorf("err = %v, want ErrValidation", err)
	}
}

func TestRename_NotFound(t *testing.T) {
	s := newMemStore()
	_, err := Rename(s, "missing", "new")
	if !errors.Is(err, ErrNotFound) {
		t.Errorf("err = %v, want ErrNotFound", err)
	}
}

// ---------------------------------------------------------------------------
// Remove
// ---------------------------------------------------------------------------

func TestRemove_HappyPath(t *testing.T) {
	s := newMemStore(core.C3Entry{ID: "abc", Name: "x"})
	if err := Remove(s, "abc", false, &fakeSessionsView{live: map[string]bool{}}); err != nil {
		t.Fatalf("Remove: %v", err)
	}
	f, _ := s.Load()
	if f.Find("abc") != nil {
		t.Error("entry still present")
	}
}

func TestRemove_NotFound(t *testing.T) {
	s := newMemStore()
	err := Remove(s, "missing", false, nil)
	if !errors.Is(err, ErrNotFound) {
		t.Errorf("err = %v, want ErrNotFound", err)
	}
}

func TestRemove_LivePTYWithoutForce(t *testing.T) {
	s := newMemStore(core.C3Entry{ID: "abc", ClaudeUUID: "u-1"})
	v := &fakeSessionsView{live: map[string]bool{"u-1": true}}
	err := Remove(s, "abc", false, v)
	if !errors.Is(err, ErrPTYLive) {
		t.Errorf("err = %v, want ErrPTYLive", err)
	}
	f, _ := s.Load()
	if f.Find("abc") == nil {
		t.Error("entry was removed despite live PTY refusal")
	}
}

func TestRemove_LivePTYWithForce(t *testing.T) {
	s := newMemStore(core.C3Entry{ID: "abc", ClaudeUUID: "u-1"})
	v := &fakeSessionsView{live: map[string]bool{"u-1": true}}
	if err := Remove(s, "abc", true, v); err != nil {
		t.Fatalf("Remove: %v", err)
	}
	// Force kills via both KillUUID(uuid) + KillKey(c3id); the second
	// is a defensive no-op-in-production but appears in the fake's
	// killed list. Assert the uuid was at least one of them.
	sawUUID := false
	for _, k := range v.killed {
		if k == "u-1" {
			sawUUID = true
		}
	}
	if !sawUUID {
		t.Errorf("killed = %v, want to contain 'u-1'", v.killed)
	}
	f, _ := s.Load()
	if f.Find("abc") != nil {
		t.Error("entry not removed")
	}
}

// ---------------------------------------------------------------------------
// NewEntry
// ---------------------------------------------------------------------------

func TestNewEntry_NameDefaultsToBasename(t *testing.T) {
	s := newMemStore()
	dir := t.TempDir() // real existing dir
	e, err := NewEntry(s, dir, "")
	if err != nil {
		t.Fatalf("NewEntry: %v", err)
	}
	wantName := filepath.Base(dir)
	if e.Name != wantName {
		t.Errorf("Name = %q, want %q", e.Name, wantName)
	}
	if e.CWD != dir {
		t.Errorf("CWD = %q, want %q", e.CWD, dir)
	}
	if e.ClaudeUUID != "" {
		t.Errorf("ClaudeUUID = %q, want empty", e.ClaudeUUID)
	}
}

func TestNewEntry_RelativeCWD(t *testing.T) {
	s := newMemStore()
	_, err := NewEntry(s, "relative/path", "")
	if !errors.Is(err, ErrValidation) {
		t.Errorf("err = %v, want ErrValidation", err)
	}
}

func TestNewEntry_NonexistentCWD(t *testing.T) {
	s := newMemStore()
	_, err := NewEntry(s, "/tmp/this-does-not-exist-c3-test-9f8a", "")
	if !errors.Is(err, ErrValidation) {
		t.Errorf("err = %v, want ErrValidation", err)
	}
}

func TestNewEntry_CWDIsFile(t *testing.T) {
	s := newMemStore()
	dir := t.TempDir()
	fp := filepath.Join(dir, "file")
	if err := os.WriteFile(fp, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	_, err := NewEntry(s, fp, "")
	if !errors.Is(err, ErrValidation) {
		t.Errorf("err = %v, want ErrValidation", err)
	}
}

func TestNewEntry_ExplicitName(t *testing.T) {
	s := newMemStore()
	dir := t.TempDir()
	e, err := NewEntry(s, dir, "Custom Name")
	if err != nil {
		t.Fatalf("NewEntry: %v", err)
	}
	if e.Name != "Custom Name" {
		t.Errorf("Name = %q, want 'Custom Name'", e.Name)
	}
}

// ---------------------------------------------------------------------------
// Bind
// ---------------------------------------------------------------------------

func TestBind_HappyPath(t *testing.T) {
	s := newMemStore(core.C3Entry{ID: "abc"})
	e, err := Bind(s, "abc", "uuid-1")
	if err != nil {
		t.Fatalf("Bind: %v", err)
	}
	if e.ClaudeUUID != "uuid-1" {
		t.Errorf("ClaudeUUID = %q, want uuid-1", e.ClaudeUUID)
	}
}

func TestBind_NotFound(t *testing.T) {
	s := newMemStore()
	_, err := Bind(s, "missing", "uuid-1")
	if !errors.Is(err, ErrNotFound) {
		t.Errorf("err = %v, want ErrNotFound", err)
	}
}

func TestBind_AlreadyBoundElsewhere(t *testing.T) {
	s := newMemStore(
		core.C3Entry{ID: "abc"},
		core.C3Entry{ID: "def", ClaudeUUID: "uuid-1"},
	)
	_, err := Bind(s, "abc", "uuid-1")
	if !errors.Is(err, ErrAlreadyBound) {
		t.Errorf("err = %v, want ErrAlreadyBound", err)
	}
}

func TestBind_IdempotentOnSameEntry(t *testing.T) {
	s := newMemStore(core.C3Entry{ID: "abc", ClaudeUUID: "uuid-1"})
	// Re-binding the same uuid to the same entry must not error — the
	// discovery loop may fire twice for the same upgrade.
	if _, err := Bind(s, "abc", "uuid-1"); err != nil {
		t.Errorf("idempotent re-bind failed: %v", err)
	}
}

func TestBind_EmptyUUID(t *testing.T) {
	s := newMemStore(core.C3Entry{ID: "abc"})
	_, err := Bind(s, "abc", "")
	if !errors.Is(err, ErrValidation) {
		t.Errorf("err = %v, want ErrValidation", err)
	}
}

// C4: rename trims whitespace; whitespace-only is rejected.
func TestRename_WhitespaceOnly(t *testing.T) {
	s := newMemStore(core.C3Entry{ID: "abc", Name: "old"})
	_, err := Rename(s, "abc", "   ")
	if !errors.Is(err, ErrValidation) {
		t.Errorf("err = %v, want ErrValidation", err)
	}
}

func TestRename_TrimsWhitespace(t *testing.T) {
	s := newMemStore(core.C3Entry{ID: "abc", Name: "old"})
	e, err := Rename(s, "abc", "  spaced  ")
	if err != nil {
		t.Fatalf("Rename: %v", err)
	}
	if e.Name != "spaced" {
		t.Errorf("Name = %q, want 'spaced'", e.Name)
	}
}

// C4: rune-counted length, not byte length — 80 CJK runes is fine.
func TestRename_UnicodeLength(t *testing.T) {
	s := newMemStore(core.C3Entry{ID: "abc"})
	// 80 CJK runes = 240 bytes. Should succeed.
	cjk := strings.Repeat("字", MaxNameLen)
	if _, err := Rename(s, "abc", cjk); err != nil {
		t.Errorf("80 CJK runes rejected: %v", err)
	}
	// 81 CJK runes — rejected.
	cjkTooLong := strings.Repeat("字", MaxNameLen+1)
	if _, err := Rename(s, "abc", cjkTooLong); !errors.Is(err, ErrValidation) {
		t.Errorf("err = %v, want ErrValidation", err)
	}
}

// B3: a pending session (uuid empty, key = c3 id, live in manager) must
// also gate Remove. Previously HasUUID("") returned false so the check
// fell through and the entry was removed, orphaning the PTY.
func TestRemove_LivePendingPTY(t *testing.T) {
	s := newMemStore(core.C3Entry{ID: "pendid", ClaudeUUID: ""})
	// "live" set keyed by c3 id (pending session). HasUUID will miss
	// because uuid is empty; HasKey must catch it.
	v := &fakeSessionsView{live: map[string]bool{"pendid": true}}
	err := Remove(s, "pendid", false, v)
	if !errors.Is(err, ErrPTYLive) {
		t.Errorf("err = %v, want ErrPTYLive", err)
	}
	f, _ := s.Load()
	if f.Find("pendid") == nil {
		t.Error("entry was removed despite pending PTY refusal")
	}
}

func TestRemove_LivePendingPTYWithForce(t *testing.T) {
	s := newMemStore(core.C3Entry{ID: "pendid"})
	v := &fakeSessionsView{live: map[string]bool{"pendid": true}}
	if err := Remove(s, "pendid", true, v); err != nil {
		t.Fatalf("Remove force: %v", err)
	}
	// Force kills via both KillUUID + KillKey; the pending session
	// satisfies KillKey.
	if len(v.killed) == 0 {
		t.Error("force did not kill anything")
	}
	f, _ := s.Load()
	if f.Find("pendid") != nil {
		t.Error("entry not removed under force")
	}
}
