// Package store persists c2-sessions — the user-curated layer on top of
// Claude's raw session UUIDs.
//
// A c2-session is an entry { id, name, cwd, claudeUuid, createdAt }. It can
// exist with claudeUuid=="" (pending lazy-link after `c2 new`) or linked.
//
// Storage: ~/.local/share/c2/sessions.json (single JSON, atomic write).
package store

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"time"
)

// Entry is one c2-session.
type Entry struct {
	ID         string    `json:"id"`         // 8-hex slug
	Name       string    `json:"name"`       // human-set, default = basename(cwd)
	CWD        string    `json:"cwd"`        // working directory
	ClaudeUUID string    `json:"claudeUuid"` // "" = pending lazy link
	CreatedAt  time.Time `json:"createdAt"`
}

// File is the on-disk schema. Archived holds c2-session IDs hidden by default.
type File struct {
	Version  int      `json:"version"`
	Sessions []Entry  `json:"sessions"`
	Archived []string `json:"archived"`
}

const currentVersion = 1

// Path returns the on-disk store path. Honors $XDG_DATA_HOME.
func Path() (string, error) {
	if d := os.Getenv("XDG_DATA_HOME"); d != "" {
		return filepath.Join(d, "c2", "sessions.json"), nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".local", "share", "c2", "sessions.json"), nil
}

// Load reads the store. Returns an empty File if it doesn't exist yet.
func Load() (*File, error) {
	p, err := Path()
	if err != nil {
		return nil, err
	}
	b, err := os.ReadFile(p)
	if errors.Is(err, fs.ErrNotExist) {
		return &File{Version: currentVersion}, nil
	}
	if err != nil {
		return nil, err
	}
	var f File
	if err := json.Unmarshal(b, &f); err != nil {
		return nil, fmt.Errorf("parse %s: %w", p, err)
	}
	if f.Version == 0 {
		f.Version = currentVersion
	}
	return &f, nil
}

// Save atomically writes the store: tmp file + rename.
func Save(f *File) error {
	p, err := Path()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		return err
	}
	f.Version = currentVersion
	b, err := json.MarshalIndent(f, "", "  ")
	if err != nil {
		return err
	}
	tmp := p + ".tmp"
	if err := os.WriteFile(tmp, b, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, p)
}

// NewID returns a fresh 8-char hex id.
func NewID() string {
	b := make([]byte, 4)
	if _, err := rand.Read(b); err != nil {
		// Should never happen on macOS; fall back to time.
		return fmt.Sprintf("%08x", time.Now().UnixNano()&0xffffffff)
	}
	return hex.EncodeToString(b)
}

// Add appends a new entry and saves. Returns the entry with ID assigned.
func (f *File) Add(name, cwd, claudeUUID string) Entry {
	e := Entry{
		ID:         NewID(),
		Name:       name,
		CWD:        cwd,
		ClaudeUUID: claudeUUID,
		CreatedAt:  time.Now(),
	}
	f.Sessions = append(f.Sessions, e)
	return e
}

// Find returns a pointer to the entry with the given ID, or nil.
func (f *File) Find(id string) *Entry {
	for i := range f.Sessions {
		if f.Sessions[i].ID == id {
			return &f.Sessions[i]
		}
	}
	return nil
}

// Archive toggles archived state for ID. Returns the new state (true=archived).
func (f *File) Archive(id string) bool {
	for i, a := range f.Archived {
		if a == id {
			f.Archived = append(f.Archived[:i], f.Archived[i+1:]...)
			return false
		}
	}
	f.Archived = append(f.Archived, id)
	return true
}

// IsArchived reports whether id is in the archived list.
func (f *File) IsArchived(id string) bool {
	for _, a := range f.Archived {
		if a == id {
			return true
		}
	}
	return false
}

// Active returns sessions sorted by CreatedAt descending, optionally
// excluding archived ones.
func (f *File) Active(includeArchived bool) []Entry {
	var out []Entry
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
