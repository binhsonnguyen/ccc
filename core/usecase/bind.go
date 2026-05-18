package usecase

import (
	"fmt"

	"github.com/binhsonnguyen/ccc/core"
)

// Bind sets the ClaudeUUID on an existing c3 entry. Returns
// ErrAlreadyBound if a DIFFERENT entry already claims this uuid (so two
// callers racing for the same Claude session can't both win), and
// ErrNotFound if c3Id doesn't resolve.
//
// Re-checks both invariants INSIDE Mutate so a concurrent bind doesn't
// slip past a read-modify-write race.
func Bind(store core.ArchiveStore, c3Id, claudeUuid string) (core.C3Entry, error) {
	if claudeUuid == "" {
		return core.C3Entry{}, fmt.Errorf("%w: claudeUuid is empty", ErrValidation)
	}
	var out core.C3Entry
	err := store.Mutate(func(f *core.ArchiveFile) error {
		// Re-check uuid is not bound to a DIFFERENT entry. Re-binding the
		// same entry to the same uuid is a no-op (idempotent for the
		// discovery loop, which may fire twice on a quick second match).
		for _, e := range f.Sessions {
			if e.ClaudeUUID == claudeUuid && e.ID != c3Id {
				return fmt.Errorf("%w: uuid %s on entry %s", ErrAlreadyBound, claudeUuid, e.ID)
			}
		}
		e := f.Find(c3Id)
		if e == nil {
			return fmt.Errorf("%w: id %s", ErrNotFound, c3Id)
		}
		e.ClaudeUUID = claudeUuid
		out = *e
		return nil
	})
	if err != nil {
		return core.C3Entry{}, err
	}
	return out, nil
}
