package usecase

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"unicode/utf8"

	"github.com/binhsonnguyen/ccc/core"
)

// NewEntry creates a new c3-session entry with an empty ClaudeUUID.
// The uuid is filled in later — either lazily (CLI) or via the server's
// pending-uuid discovery loop after the PTY actually spawns claude.
//
// `cwd` must be an absolute path to an existing directory. We stat it
// here so a typo doesn't quietly create a useless entry whose later
// attach will fail with a confusing "no such file or directory" from
// the PTY spawn. If `name` is empty, it defaults to filepath.Base(cwd).
func NewEntry(store core.ArchiveStore, cwd, name string) (core.C3Entry, error) {
	if !filepath.IsAbs(cwd) {
		return core.C3Entry{}, fmt.Errorf("%w: cwd must be absolute, got %q", ErrValidation, cwd)
	}
	info, err := os.Stat(cwd)
	if err != nil {
		return core.C3Entry{}, fmt.Errorf("%w: cwd: %v", ErrValidation, err)
	}
	if !info.IsDir() {
		return core.C3Entry{}, fmt.Errorf("%w: cwd is not a directory: %s", ErrValidation, cwd)
	}
	if name == "" {
		name = filepath.Base(cwd)
	}
	name = strings.TrimSpace(name)
	if name == "" {
		return core.C3Entry{}, fmt.Errorf("%w: name is empty", ErrValidation)
	}
	if utf8.RuneCountInString(name) > MaxNameLen {
		return core.C3Entry{}, fmt.Errorf("%w: name exceeds %d chars", ErrValidation, MaxNameLen)
	}
	var created core.C3Entry
	err = store.Mutate(func(f *core.ArchiveFile) error {
		created = f.AddEntry(name, cwd, "")
		return nil
	})
	if err != nil {
		return core.C3Entry{}, err
	}
	return created, nil
}
