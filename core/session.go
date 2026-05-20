package core

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"sort"
	"time"
)

// Session mirrors a Claude raw JSONL session. JSON tags are camelCase to
// match the rest of the public API (see C3Entry); GET /api/claude-sessions
// returns `unbound: []Session` and the web client deserialises via those
// names. IndexPath/JSONLPath/GitBranch are internal-only — omit from wire.
type Session struct {
	UUID      string    `json:"uuid"`
	CWD       string    `json:"cwd"`
	Summary   string    `json:"summary"`
	GitBranch string    `json:"gitBranch,omitempty"`
	Modified  time.Time `json:"modified"`
	IndexPath string    `json:"-"`
	JSONLPath string    `json:"-"`
	Sidechain bool      `json:"sidechain,omitempty"`
}

type C3Entry struct {
	ID         string    `json:"id"`
	Name       string    `json:"name"`
	CWD        string    `json:"cwd"`
	ClaudeUUID string    `json:"claudeUuid"`
	CreatedAt  time.Time `json:"createdAt"`
	// Kind discriminates entry type. Empty == legacy "claude" entry (zero
	// migration on disk: existing archive.json reads back as Kind==""). The
	// only explicit value today is "shell" — a plain `$SHELL -i` PTY with
	// no Claude side, no JSONL, no discovery loop. ClaudeUUID is unused
	// (and must stay empty) for shell entries; the c3-id is the primary
	// key for life.
	Kind string `json:"kind,omitempty"`
	// Command is the exact argv to spawn for a shell entry. nil ⇒ default
	// ($SHELL -i; /bin/bash -i if SHELL unset). Non-nil and non-empty
	// overrides argv verbatim. Empty-but-non-nil ([]string{}) is rejected
	// at write time so the field stays "nil = default, set = use". Ignored
	// for claude entries.
	Command []string `json:"command,omitempty"`
}

// IsShell reports whether this entry is a plain shell (vs. a claude session).
// Centralises the Kind comparison so the rest of the codebase doesn't have
// to remember the magic string.
func (e *C3Entry) IsShell() bool { return e.Kind == "shell" }

type ArchiveFile struct {
	Version  int       `json:"version"`
	Sessions []C3Entry `json:"sessions"`
	Archived []string  `json:"archived"`
}

const CurrentVersion = 1

// NewID returns a fresh 8-char hex id, used as the c3-session slug.
func NewID() string {
	b := make([]byte, 4)
	if _, err := rand.Read(b); err != nil {
		return fmt.Sprintf("%08x", time.Now().UnixNano()&0xffffffff)
	}
	return hex.EncodeToString(b)
}

func (f *ArchiveFile) Find(id string) *C3Entry {
	for i := range f.Sessions {
		if f.Sessions[i].ID == id {
			return &f.Sessions[i]
		}
	}
	return nil
}

func (f *ArchiveFile) IsArchived(id string) bool {
	for _, a := range f.Archived {
		if a == id {
			return true
		}
	}
	return false
}

// ToggleArchive flips archived state for id, returns new state (true=archived).
func (f *ArchiveFile) ToggleArchive(id string) bool {
	for i, a := range f.Archived {
		if a == id {
			f.Archived = append(f.Archived[:i], f.Archived[i+1:]...)
			return false
		}
	}
	f.Archived = append(f.Archived, id)
	return true
}

// RemoveArchived drops id from Archived list if present (idempotent).
func (f *ArchiveFile) RemoveArchived(id string) {
	for i, a := range f.Archived {
		if a == id {
			f.Archived = append(f.Archived[:i], f.Archived[i+1:]...)
			return
		}
	}
}

// AddEntry appends a new c3-session with a fresh ID + CreatedAt.
func (f *ArchiveFile) AddEntry(name, cwd, claudeUUID string) C3Entry {
	e := C3Entry{
		ID:         NewID(),
		Name:       name,
		CWD:        cwd,
		ClaudeUUID: claudeUUID,
		CreatedAt:  time.Now(),
	}
	f.Sessions = append(f.Sessions, e)
	return e
}

// AddShellEntry appends a new shell c3-session. Argv may be nil (caller
// wants the default $SHELL -i spawn) but never empty — caller validates.
func (f *ArchiveFile) AddShellEntry(name, cwd string, argv []string) C3Entry {
	e := C3Entry{
		ID:        NewID(),
		Name:      name,
		CWD:       cwd,
		Kind:      "shell",
		Command:   argv,
		CreatedAt: time.Now(),
	}
	f.Sessions = append(f.Sessions, e)
	return e
}

// ListActive returns non-archived entries sorted by CreatedAt desc.
func (f *ArchiveFile) ListActive() []C3Entry { return f.filterAndSort(false) }

// ListAll returns every entry (archived included) sorted by CreatedAt desc.
func (f *ArchiveFile) ListAll() []C3Entry { return f.filterAndSort(true) }

// ListArchived returns only archived entries, in stored order.
func (f *ArchiveFile) ListArchived() []C3Entry {
	archivedSet := map[string]bool{}
	for _, id := range f.Archived {
		archivedSet[id] = true
	}
	var out []C3Entry
	for _, e := range f.Sessions {
		if archivedSet[e.ID] {
			out = append(out, e)
		}
	}
	return out
}

func (f *ArchiveFile) filterAndSort(includeArchived bool) []C3Entry {
	var out []C3Entry
	for _, e := range f.Sessions {
		if !includeArchived && f.IsArchived(e.ID) {
			continue
		}
		out = append(out, e)
	}
	sort.Slice(out, func(i, j int) bool {
		return out[i].CreatedAt.After(out[j].CreatedAt)
	})
	return out
}

// UnboundClaudeSessions filters `all` to non-sidechain sessions whose UUID is
// not yet adopted by any c3-session.
func (f *ArchiveFile) UnboundClaudeSessions(all []Session) []Session {
	bound := map[string]bool{}
	for _, e := range f.Sessions {
		if e.ClaudeUUID != "" {
			bound[e.ClaudeUUID] = true
		}
	}
	var out []Session
	for _, s := range all {
		if !s.Sidechain && !bound[s.UUID] {
			out = append(out, s)
		}
	}
	return out
}
