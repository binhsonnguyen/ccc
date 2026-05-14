package archivejson

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"syscall"

	"c2/core"
)

type Store struct{}

func New() *Store { return &Store{} }

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

func (s *Store) Load() (*core.ArchiveFile, error) {
	p, err := Path()
	if err != nil {
		return nil, err
	}
	b, err := os.ReadFile(p)
	if errors.Is(err, fs.ErrNotExist) {
		return &core.ArchiveFile{Version: core.CurrentVersion}, nil
	}
	if err != nil {
		return nil, err
	}
	var f core.ArchiveFile
	if err := json.Unmarshal(b, &f); err != nil {
		return nil, fmt.Errorf("parse %s: %w", p, err)
	}
	if f.Version == 0 {
		f.Version = core.CurrentVersion
	}
	return &f, nil
}

func (s *Store) Save(f *core.ArchiveFile) error {
	p, err := Path()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		return err
	}
	f.Version = core.CurrentVersion
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

func lockPath() (string, error) {
	p, err := Path()
	if err != nil {
		return "", err
	}
	return p + ".lock", nil
}

func (s *Store) Mutate(fn func(*core.ArchiveFile) error) error {
	lp, err := lockPath()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(lp), 0o755); err != nil {
		return err
	}
	lf, err := os.OpenFile(lp, os.O_CREATE|os.O_RDWR, 0o644)
	if err != nil {
		return fmt.Errorf("open lock: %w", err)
	}
	defer lf.Close()
	if err := syscall.Flock(int(lf.Fd()), syscall.LOCK_EX); err != nil {
		return fmt.Errorf("flock: %w", err)
	}
	defer syscall.Flock(int(lf.Fd()), syscall.LOCK_UN)

	f, err := s.Load()
	if err != nil {
		return err
	}
	if err := fn(f); err != nil {
		return err
	}
	return s.Save(f)
}

