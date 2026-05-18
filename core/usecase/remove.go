package usecase

import (
	"fmt"

	"github.com/binhsonnguyen/ccc/core"
)

// Remove deletes a c3-session entry. Refuses (ErrPTYLive) if a live PTY
// is attached either by ClaudeUUID (resumed-session path) or by c3 id
// (pending-session path, where the PTY is keyed by c3 id because Claude
// hasn't written a JSONL yet). With force=true, kills both possibilities
// before removing the entry — orphaning a pending PTY would leak a
// `claude` process with no entry to reattach to.
//
// `manager` may be nil — callers without an attached PTY pool (CLI in
// in-process mode) pass nil to skip the live-PTY check entirely.
func Remove(store core.ArchiveStore, id string, force bool, manager core.SessionsView) error {
	if manager != nil {
		var uuid string
		if err := readEntry(store, id, &uuid); err != nil {
			return err
		}
		uuidLive := uuid != "" && manager.HasUUID(uuid)
		keyLive := manager.HasKey(id)
		if uuidLive || keyLive {
			if !force {
				return fmt.Errorf("%w: %s", ErrPTYLive, id)
			}
			// Kill both lookups; each is a no-op when absent. Running
			// both handles the race where uuid was discovered between
			// the check above and the kill.
			manager.KillUUID(uuid)
			manager.KillKey(id)
		}
	}
	return store.Mutate(func(f *core.ArchiveFile) error {
		for i, e := range f.Sessions {
			if e.ID == id {
				f.Sessions = append(f.Sessions[:i], f.Sessions[i+1:]...)
				f.RemoveArchived(id)
				return nil
			}
		}
		return fmt.Errorf("%w: id %s", ErrNotFound, id)
	})
}

// readEntry is a small read-only helper that loads the file and pulls one
// entry's ClaudeUUID by id. Returns ErrNotFound if missing. Used to gate
// Remove on live-PTY status before taking the write lock.
func readEntry(store core.ArchiveStore, id string, outUUID *string) error {
	f, err := store.Load()
	if err != nil {
		return err
	}
	e := f.Find(id)
	if e == nil {
		return fmt.Errorf("%w: id %s", ErrNotFound, id)
	}
	*outUUID = e.ClaudeUUID
	return nil
}
