package usecase

import (
	"fmt"
	"strings"
	"unicode/utf8"

	"github.com/binhsonnguyen/ccc/core"
)

// MaxNameLen caps c3-session display name length, measured in runes (not
// bytes) so CJK input gets a fair shake. Picked high enough to hold a
// path basename + brief annotation, low enough to fit on a row.
const MaxNameLen = 80

// Rename validates and atomically updates the display name of a c3-session.
// Validation runs before Mutate so a bad input never takes the file lock.
// Whitespace-only names are rejected — they render as a blank row.
func Rename(store core.ArchiveStore, id, newName string) (core.C3Entry, error) {
	trimmed := strings.TrimSpace(newName)
	if trimmed == "" {
		return core.C3Entry{}, fmt.Errorf("%w: name is empty", ErrValidation)
	}
	if utf8.RuneCountInString(trimmed) > MaxNameLen {
		return core.C3Entry{}, fmt.Errorf("%w: name exceeds %d chars", ErrValidation, MaxNameLen)
	}
	newName = trimmed
	var out core.C3Entry
	err := store.Mutate(func(f *core.ArchiveFile) error {
		e := f.Find(id)
		if e == nil {
			return fmt.Errorf("%w: id %s", ErrNotFound, id)
		}
		e.Name = newName
		out = *e
		return nil
	})
	if err != nil {
		return core.C3Entry{}, err
	}
	return out, nil
}
