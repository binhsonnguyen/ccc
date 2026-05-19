package usecase

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"unicode/utf8"

	"github.com/binhsonnguyen/ccc/core"
)

// uuidV4Pattern is a permissive uuid syntactic check: 8-4-4-4-12 hex
// (case-insensitive). We don't enforce the version/variant nibbles —
// claude itself accepts any well-formed uuid for --session-id.
var uuidV4Pattern = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)

// IsValidUUID reports whether s syntactically matches the uuid format.
// Exposed for the HTTP layer; usecase callers can also rely on NewEntry
// returning ErrValidation for malformed inputs.
func IsValidUUID(s string) bool { return uuidV4Pattern.MatchString(s) }

// NewEntry creates a new c3-session entry. Optional trailing `claudeUUID`
// arg pre-binds the entry to a Claude session id (inline first-prompt
// flow). When empty/omitted, the uuid is filled in later — either lazily
// (CLI) or via the server's pending-uuid discovery loop after the PTY
// actually spawns claude.
//
// `cwd` must be an absolute path to an existing directory. We stat it
// here so a typo doesn't quietly create a useless entry whose later
// attach will fail with a confusing "no such file or directory" from
// the PTY spawn. If `name` is empty, it defaults to filepath.Base(cwd).
//
// When claudeUUID is non-empty it must be syntactically valid and not
// already adopted by another entry — otherwise the server's --session-id
// spawn would fail or two entries would race for the same JSONL.
func NewEntry(store core.ArchiveStore, cwd, name string, claudeUUID ...string) (core.C3Entry, error) {
	uuid := ""
	if len(claudeUUID) > 0 {
		uuid = strings.TrimSpace(claudeUUID[0])
	}
	if uuid != "" && !IsValidUUID(uuid) {
		return core.C3Entry{}, fmt.Errorf("%w: claudeUuid is not a valid uuid", ErrValidation)
	}
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
		if uuid != "" {
			// Defend against the (astronomically unlikely) v4 collision
			// AND against a client replaying a uuid that some other
			// entry already adopted via Bind. Either way return
			// ErrAlreadyBound so the server maps it to 409.
			for _, e := range f.Sessions {
				if e.ClaudeUUID == uuid {
					return fmt.Errorf("%w: claudeUuid already adopted", ErrAlreadyBound)
				}
			}
		}
		created = f.AddEntry(name, cwd, uuid)
		return nil
	})
	if err != nil {
		return core.C3Entry{}, err
	}
	return created, nil
}
