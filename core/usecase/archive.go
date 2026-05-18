package usecase

import (
	"fmt"

	"github.com/binhsonnguyen/ccc/core"
)

// ToggleArchive flips archived state for id under a Mutate lock so the
// read-modify-write is atomic vs concurrent c3 processes.
func ToggleArchive(store core.ArchiveStore, id string) (entry core.C3Entry, archived bool, err error) {
	var found core.C3Entry
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
		return core.C3Entry{}, false, err
	}
	return found, archived, nil
}
