// Package envset stores named sets of environment variables and resolves
// them into the overlay that c3-server injects into spawned `claude` / shell
// PTYs. It generalises the earlier provider-switch feature: an "env set" is
// just a labelled bag of KEY=VALUE (and KEY-unset) entries, and the
// Anthropic / DeepSeek backends are simply two seeded sets.
//
// Two application scopes compose, in order:
//   - GLOBAL active sets (Config.Active) — applied to every new PTY.
//   - PER-SESSION sets (stored on the C3Entry) — layered on top for that one
//     session. Later ops win, so a session set can override a global one.
//
// Secrets vs plaintext are kept in separate files, like before:
//   - envsets.json   (0644) — set definitions: labels, keys, non-secret
//     values, secret/unset flags. Hand-editable.
//   - envsecrets.json (0600) — secret values, keyed setID → key. Never served
//     back to the browser (the API reports only a hasValue boolean).
//
// A Var with Secret=true draws its value from envsecrets.json (empty ⇒ the op
// is skipped, so an unconfigured secret never clobbers an inherited value).
// A Var with Unset=true removes the key from the child env — that's how a set
// strips a stale credential left in the user's shell rc so the intended one
// wins (Claude Code's ANTHROPIC_AUTH_TOKEN / ANTHROPIC_API_KEY outrank
// CLAUDE_CODE_OAUTH_TOKEN, so the OAuth set unsets the first two).
package envset

import (
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"sync"

	"github.com/binhsonnguyen/ccc/adapters/ptyrunner"
)

// Var is one entry in a set. Exactly one behaviour applies, checked in this
// order: Unset removes the key; Secret pulls the value from envsecrets.json;
// otherwise Value is used verbatim.
type Var struct {
	Key    string `json:"key"`
	Value  string `json:"value,omitempty"`
	Secret bool   `json:"secret,omitempty"`
	Unset  bool   `json:"unset,omitempty"`
}

// Set is a named collection of env vars.
type Set struct {
	Label string `json:"label"`
	Vars  []Var  `json:"vars"`
}

// Config is the persisted envsets.json shape. Active lists the globally-active
// set ids in apply order; Order drives the UI listing.
type Config struct {
	Active []string       `json:"active"`
	Order  []string       `json:"order,omitempty"`
	Sets   map[string]Set `json:"sets"`
}

// Store reads/writes the env-set config + secrets under the c3 data dir.
// Writes are serialised by mu and made atomic via temp+rename.
type Store struct {
	mu sync.Mutex
}

func New() *Store { return &Store{} }

func dataFilePath(name string) (string, error) {
	if d := os.Getenv("XDG_DATA_HOME"); d != "" {
		return filepath.Join(d, "c3", name), nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".local", "share", "c3", name), nil
}

func setsPath() (string, error)    { return dataFilePath("envsets.json") }
func secretsPath() (string, error) { return dataFilePath("envsecrets.json") }

// defaultConfig seeds envsets.json on first read: an Anthropic set (OAuth /
// existing login; unsets the higher-precedence credential vars) and a DeepSeek
// set (Bearer token + base URL + model mapping). Active is empty so nothing
// changes until the user activates a set.
func defaultConfig() *Config {
	return &Config{
		Active: []string{},
		Order:  []string{"anthropic", "deepseek"},
		Sets: map[string]Set{
			"anthropic": {
				Label: "Anthropic",
				Vars: []Var{
					{Key: "ANTHROPIC_BASE_URL", Unset: true},
					{Key: "ANTHROPIC_AUTH_TOKEN", Unset: true},
					{Key: "ANTHROPIC_API_KEY", Unset: true},
					// Optional `claude setup-token` OAuth token; leave unset to
					// use the existing `claude login` session.
					{Key: "CLAUDE_CODE_OAUTH_TOKEN", Secret: true},
				},
			},
			"deepseek": {
				Label: "DeepSeek",
				Vars: []Var{
					{Key: "ANTHROPIC_BASE_URL", Value: "https://api.deepseek.com/anthropic"},
					{Key: "ANTHROPIC_AUTH_TOKEN", Secret: true},
					{Key: "ANTHROPIC_API_KEY", Unset: true},
					{Key: "CLAUDE_CODE_OAUTH_TOKEN", Unset: true},
					{Key: "ANTHROPIC_MODEL", Value: "deepseek-v4-pro[1m]"},
					{Key: "ANTHROPIC_DEFAULT_OPUS_MODEL", Value: "deepseek-v4-pro[1m]"},
					{Key: "ANTHROPIC_DEFAULT_SONNET_MODEL", Value: "deepseek-v4-pro[1m]"},
					{Key: "ANTHROPIC_DEFAULT_HAIKU_MODEL", Value: "deepseek-v4-flash"},
					{Key: "CLAUDE_CODE_SUBAGENT_MODEL", Value: "deepseek-v4-flash"},
					{Key: "CLAUDE_CODE_EFFORT_LEVEL", Value: "max"},
				},
			},
		},
	}
}

// Load returns the persisted config, seeding (not writing) defaults when
// envsets.json is absent.
func (s *Store) Load() (*Config, error) {
	p, err := setsPath()
	if err != nil {
		return nil, err
	}
	b, err := os.ReadFile(p)
	if errors.Is(err, fs.ErrNotExist) {
		return defaultConfig(), nil
	}
	if err != nil {
		return nil, err
	}
	var c Config
	if err := json.Unmarshal(b, &c); err != nil {
		return nil, err
	}
	if c.Sets == nil {
		c.Sets = map[string]Set{}
	}
	if c.Active == nil {
		c.Active = []string{}
	}
	return &c, nil
}

func (s *Store) loadSecrets() (map[string]map[string]string, error) {
	p, err := secretsPath()
	if err != nil {
		return nil, err
	}
	b, err := os.ReadFile(p)
	if errors.Is(err, fs.ErrNotExist) {
		return map[string]map[string]string{}, nil
	}
	if err != nil {
		return nil, err
	}
	var m map[string]map[string]string
	if err := json.Unmarshal(b, &m); err != nil {
		return nil, err
	}
	if m == nil {
		m = map[string]map[string]string{}
	}
	return m, nil
}

func (s *Store) saveSecrets(m map[string]map[string]string) error {
	p, err := secretsPath()
	if err != nil {
		return err
	}
	return writeFileAtomic(p, m, 0o600)
}

func (s *Store) saveConfig(c *Config) error {
	p, err := setsPath()
	if err != nil {
		return err
	}
	return writeFileAtomic(p, c, 0o644)
}

// resolveOps turns the named sets (in order) into ordered env ops. Secret
// values are pulled from the secrets store; an empty secret is skipped so it
// can't clobber an inherited value with "".
func (s *Store) resolveOps(ids []string, c *Config, secrets map[string]map[string]string) []ptyrunner.EnvOp {
	var ops []ptyrunner.EnvOp
	for _, id := range ids {
		set, ok := c.Sets[id]
		if !ok {
			continue
		}
		for _, v := range set.Vars {
			switch {
			case v.Unset:
				ops = append(ops, ptyrunner.EnvOp{Key: v.Key, Unset: true})
			case v.Secret:
				val := secrets[id][v.Key]
				if val == "" {
					continue // unconfigured secret: leave inherited value alone
				}
				ops = append(ops, ptyrunner.EnvOp{Key: v.Key, Value: val})
			default:
				ops = append(ops, ptyrunner.EnvOp{Key: v.Key, Value: v.Value})
			}
		}
	}
	return ops
}

// GlobalOverlay resolves the globally-active sets. Wired into
// ptyrunner.EnvOverlay; read fresh per spawn. Returns nil on error or when no
// set is active (passthrough).
func (s *Store) GlobalOverlay() []ptyrunner.EnvOp {
	c, err := s.Load()
	if err != nil || len(c.Active) == 0 {
		return nil
	}
	secrets, err := s.loadSecrets()
	if err != nil {
		return nil
	}
	return s.resolveOps(c.Active, c, secrets)
}

// Resolve resolves an explicit list of set ids (per-session use). Unknown ids
// are skipped. Returns nil for an empty/nil list.
func (s *Store) Resolve(ids []string) []ptyrunner.EnvOp {
	if len(ids) == 0 {
		return nil
	}
	c, err := s.Load()
	if err != nil {
		return nil
	}
	secrets, err := s.loadSecrets()
	if err != nil {
		return nil
	}
	return s.resolveOps(ids, c, secrets)
}

// SetActive replaces the globally-active set list. Unknown ids are rejected so
// the UI can't activate a phantom set.
func (s *Store) SetActive(ids []string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	c, err := s.Load()
	if err != nil {
		return err
	}
	for _, id := range ids {
		if _, ok := c.Sets[id]; !ok {
			return errors.New("unknown env set: " + id)
		}
	}
	if ids == nil {
		ids = []string{}
	}
	c.Active = ids
	return s.saveConfig(c)
}

// UpsertSet creates or replaces a set definition (labels/keys/non-secret
// values/flags). Secret values are managed separately via SetSecret.
func (s *Store) UpsertSet(id string, set Set) error {
	if id == "" {
		return errors.New("set id is empty")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	c, err := s.Load()
	if err != nil {
		return err
	}
	if _, ok := c.Sets[id]; !ok {
		c.Order = append(c.Order, id)
	}
	c.Sets[id] = set
	return s.saveConfig(c)
}

// DeleteSet removes a set, its secrets, and its membership in Active/Order.
func (s *Store) DeleteSet(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	c, err := s.Load()
	if err != nil {
		return err
	}
	delete(c.Sets, id)
	c.Active = without(c.Active, id)
	c.Order = without(c.Order, id)
	if err := s.saveConfig(c); err != nil {
		return err
	}
	secrets, err := s.loadSecrets()
	if err != nil {
		return nil // config already saved; secrets cleanup is best-effort
	}
	if _, ok := secrets[id]; ok {
		delete(secrets, id)
		return s.saveSecrets(secrets)
	}
	return nil
}

// SetSecret stores (or clears, when value == "") a secret value for setID/key.
// The set must exist and the key must be declared Secret in that set.
func (s *Store) SetSecret(setID, key, value string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	c, err := s.Load()
	if err != nil {
		return err
	}
	set, ok := c.Sets[setID]
	if !ok {
		return errors.New("unknown env set: " + setID)
	}
	if !hasSecretKey(set, key) {
		return errors.New("key is not a secret in this set: " + key)
	}
	secrets, err := s.loadSecrets()
	if err != nil {
		return err
	}
	if value == "" {
		delete(secrets[setID], key)
		if len(secrets[setID]) == 0 {
			delete(secrets, setID)
		}
	} else {
		if secrets[setID] == nil {
			secrets[setID] = map[string]string{}
		}
		secrets[setID][key] = value
	}
	return s.saveSecrets(secrets)
}

// hasSecret reports whether a non-empty secret value is stored for setID/key.
func (s *Store) hasSecret(secrets map[string]map[string]string, setID, key string) bool {
	return secrets[setID][key] != ""
}

// HasToken reports whether a non-empty secret value is stored for setID/key.
// Convenience wrapper around a secrets load (mostly for tests / callers that
// don't already hold the secrets map).
func (s *Store) HasToken(setID, key string) (bool, error) {
	secrets, err := s.loadSecrets()
	if err != nil {
		return false, err
	}
	return s.hasSecret(secrets, setID, key), nil
}

func hasSecretKey(set Set, key string) bool {
	for _, v := range set.Vars {
		if v.Key == key && v.Secret {
			return true
		}
	}
	return false
}

func without(ss []string, id string) []string {
	out := ss[:0:0]
	for _, x := range ss {
		if x != id {
			out = append(out, x)
		}
	}
	return out
}

func writeFileAtomic(path string, v any, perm os.FileMode) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	b, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, b, perm); err != nil {
		return err
	}
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	return nil
}
