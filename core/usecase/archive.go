package usecase

import (
	"fmt"

	"c2/core"
)

// ToggleArchive flips archived state for id under a Mutate lock so the
// read-modify-write is atomic vs concurrent c2 processes.
func ToggleArchive(store core.ArchiveStore, id string) (entry core.C2Entry, archived bool, err error) {
	var found core.C2Entry
	err = store.Mutate(func(f *core.ArchiveFile) error {
		e := f.Find(id)
		if e == nil {
			return fmt.Errorf("no session with id %s", id)
		}
		found = *e
		archived = f.ToggleArchive(id)
		return nil
	})
	if err != nil {
		return core.C2Entry{}, false, err
	}
	return found, archived, nil
}
