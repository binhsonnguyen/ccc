package envset

import (
	"encoding/json"
	"errors"
	"io/fs"
	"os"
)

// VarView is a set var as surfaced to the browser. For a secret var Value is
// blank and HasValue reports whether a value is stored — the secret itself
// never leaves the server.
type VarView struct {
	Key      string `json:"key"`
	Value    string `json:"value"`
	Secret   bool   `json:"secret"`
	Unset    bool   `json:"unset"`
	HasValue bool   `json:"hasValue"`
}

type SetView struct {
	ID    string    `json:"id"`
	Label string    `json:"label"`
	Vars  []VarView `json:"vars"`
}

// View is the GET /api/envsets payload: the globally-active set ids plus the
// ordered set list with secrets masked.
type View struct {
	Active []string  `json:"active"`
	Sets   []SetView `json:"sets"`
}

// View returns the masked config for the API.
func (s *Store) View() (*View, error) {
	c, err := s.Load()
	if err != nil {
		return nil, err
	}
	secrets, err := s.loadSecrets()
	if err != nil {
		return nil, err
	}
	v := &View{Active: c.Active, Sets: []SetView{}}
	for _, id := range orderedIDs(c) {
		set := c.Sets[id]
		sv := SetView{ID: id, Label: set.Label, Vars: []VarView{}}
		for _, va := range set.Vars {
			vv := VarView{Key: va.Key, Secret: va.Secret, Unset: va.Unset}
			if va.Secret {
				vv.HasValue = s.hasSecret(secrets, id, va.Key)
			} else if !va.Unset {
				vv.Value = va.Value
			}
			sv.Vars = append(sv.Vars, vv)
		}
		v.Sets = append(v.Sets, sv)
	}
	return v, nil
}

// orderedIDs lists set ids by Config.Order first, then any not listed there.
func orderedIDs(c *Config) []string {
	seen := map[string]bool{}
	var ids []string
	for _, id := range c.Order {
		if _, ok := c.Sets[id]; ok && !seen[id] {
			ids = append(ids, id)
			seen[id] = true
		}
	}
	for id := range c.Sets {
		if !seen[id] {
			ids = append(ids, id)
			seen[id] = true
		}
	}
	return ids
}

// Migrate is a best-effort one-time import from the older provider-switch
// files (providers.json + flat secrets.json, shipped v0.2.42–0.2.43). It runs
// only when envsets.json doesn't exist yet: it seeds the default sets and
// copies any stored provider tokens into the matching seeded secret keys
// (deepseek → ANTHROPIC_AUTH_TOKEN, anthropic → CLAUDE_CODE_OAUTH_TOKEN), so a
// token the user already entered isn't lost. Errors are returned for logging
// only; failure just means starting from clean defaults.
func (s *Store) Migrate() error {
	p, err := setsPath()
	if err != nil {
		return err
	}
	if _, err := os.Stat(p); err == nil {
		return nil // already on the new format
	} else if !errors.Is(err, fs.ErrNotExist) {
		return err
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	cfg := defaultConfig()
	if err := s.saveConfig(cfg); err != nil {
		return err
	}

	// Import old flat tokens, if any.
	old, err := dataFilePath("secrets.json")
	if err != nil {
		return err
	}
	b, err := os.ReadFile(old)
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	var flat map[string]string
	if json.Unmarshal(b, &flat) != nil {
		return nil // not the old flat shape; nothing to import
	}
	secrets := map[string]map[string]string{}
	mapping := map[string]string{
		"deepseek":  "ANTHROPIC_AUTH_TOKEN",
		"anthropic": "CLAUDE_CODE_OAUTH_TOKEN",
	}
	for profile, key := range mapping {
		if tok := flat[profile]; tok != "" {
			secrets[profile] = map[string]string{key: tok}
		}
	}
	if len(secrets) == 0 {
		return nil
	}
	return s.saveSecrets(secrets)
}
