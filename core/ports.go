package core

// ArchiveStore persists the c2-session list. Mutate wraps a read-modify-write
// under a file lock so CLI and (future) server don't lose updates.
type ArchiveStore interface {
	Load() (*ArchiveFile, error)
	Save(*ArchiveFile) error
	Mutate(func(*ArchiveFile) error) error
}
