package core

// ArchiveStore persists the c3-session list. Mutate wraps a read-modify-write
// under a file lock so CLI and (future) server don't lose updates.
type ArchiveStore interface {
	Load() (*ArchiveFile, error)
	Save(*ArchiveFile) error
	Mutate(func(*ArchiveFile) error) error
}

// SessionsView is the read-only window the server's PTY manager
// exposes to use-cases that need to gate destructive ops on live
// session presence. Kept minimal so core stays adapter-free.
//
// HasUUID / KillUUID look up by Claude session uuid. HasKey / KillKey
// look up by the manager's internal session key (c3 id while a session
// is pending, uuid otherwise). Use-cases that delete c3 entries must
// check BOTH — a pending session is keyed by c3 id with an empty uuid,
// so HasUUID alone misses it.
type SessionsView interface {
	HasUUID(uuid string) bool
	KillUUID(uuid string) // best-effort; no-op if absent
	HasKey(key string) bool
	KillKey(key string) // best-effort; no-op if absent
}
