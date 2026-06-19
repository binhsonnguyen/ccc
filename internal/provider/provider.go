// Package provider stores the user's LLM-provider profiles (Anthropic,
// DeepSeek, …) and the long-lived auth tokens for each, then computes the
// environment overlay that c3-server injects into every spawned `claude`
// PTY.
//
// This is the one place c3 deliberately steps beyond its thin-wrapper role
// of "never own session data": a provider token is a *secret*, not session
// data, and the claude CLI has no mechanism to remember a DeepSeek token
// across launches. We keep the secret strictly separated from session data:
//
//   - providers.json  (0644) — non-sensitive: profile labels, base URLs, the
//     model-mapping env vars. Hand-editable.
//   - secrets.json    (0600) — auth tokens keyed by profile id. Never served
//     back to the browser; the API only ever reports a hasToken boolean.
//
// The active profile is global: it applies to every NEW claude PTY. Because
// env is read by claude only at process spawn, switching the active profile
// does NOT affect already-running sessions — only ones started afterwards.
//
// Overlay() is read fresh on every spawn (no caching), so a toggle in the UI
// takes effect on the very next session without restarting the daemon. This
// is the opposite of ptyrunner.loginShellEnv()'s sync.Once cache, and
// intentionally so.
package provider

import (
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"sync"
)

// Profile is one provider configuration. Env holds the model-selection and
// behaviour env vars (ANTHROPIC_MODEL, ANTHROPIC_DEFAULT_*_MODEL,
// CLAUDE_CODE_SUBAGENT_MODEL, CLAUDE_CODE_EFFORT_LEVEL, …). The auth token is
// NOT stored here — it lives in secrets.json and is injected at overlay time
// into the env var named by TokenEnv.
//
// TokenEnv selects HOW the stored token authenticates, because Claude Code
// sends different env vars over different HTTP headers:
//   - ANTHROPIC_AUTH_TOKEN     → "Authorization: Bearer" (gateways: DeepSeek,
//     any Anthropic-compatible proxy). This is the default when TokenEnv is "".
//   - ANTHROPIC_API_KEY        → "x-api-key" (a standard console key against
//     api.anthropic.com — a Bearer token would NOT authenticate there).
//   - CLAUDE_CODE_OAUTH_TOKEN  → long-lived OAuth token from `claude
//     setup-token` (uses the Pro/Max subscription, no per-call API billing).
type Profile struct {
	Label    string            `json:"label"`
	BaseURL  string            `json:"baseUrl"`
	TokenEnv string            `json:"tokenEnv,omitempty"`
	Env      map[string]string `json:"env,omitempty"`
}

// TokenEnvName returns the env var the profile's token is injected into,
// defaulting to ANTHROPIC_AUTH_TOKEN (Bearer) for proxy/gateway providers.
func (p Profile) TokenEnvName() string {
	if p.TokenEnv != "" {
		return p.TokenEnv
	}
	return "ANTHROPIC_AUTH_TOKEN"
}

// authEnvVars are the credential env vars Claude Code consults, in
// descending precedence (AUTH_TOKEN and API_KEY both outrank
// CLAUDE_CODE_OAUTH_TOKEN). The overlay clears ALL of them before setting the
// active profile's chosen one — otherwise a higher-precedence var left in the
// user's shell rc (e.g. a stray ANTHROPIC_API_KEY) would silently win over an
// injected OAuth token.
var authEnvVars = []string{
	"ANTHROPIC_AUTH_TOKEN",
	"ANTHROPIC_API_KEY",
	"CLAUDE_CODE_OAUTH_TOKEN",
}

// Config is the persisted providers.json shape. Active is the id of the
// profile applied to new sessions; "" means "no managed profile" — c3
// injects and strips nothing, so claude sees exactly the login-shell env
// (the pre-feature behaviour). Order drives the UI listing.
type Config struct {
	Active   string             `json:"active"`
	Order    []string           `json:"order,omitempty"`
	Profiles map[string]Profile `json:"profiles"`
}

// Store reads/writes the provider config + secrets under the c3 data dir.
// All methods are safe for concurrent use; writes are serialised by mu and
// made atomic via temp+rename.
type Store struct {
	mu sync.Mutex
}

func New() *Store { return &Store{} }

// dataFilePath mirrors the c3-server data-dir convention
// (~/.local/share/c3 or $XDG_DATA_HOME/c3). Kept local so the provider
// package has no dependency on the server command.
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

func providersPath() (string, error) { return dataFilePath("providers.json") }
func secretsPath() (string, error)   { return dataFilePath("secrets.json") }

// defaultConfig is seeded the first time providers.json is read. Active is
// "" (passthrough) so installing the feature changes nothing until the user
// explicitly picks a provider. The DeepSeek profile is pre-filled with the
// Anthropic-compatible base URL + the model mapping; the user supplies the
// token via the UI.
func defaultConfig() *Config {
	return &Config{
		Active: "",
		Order:  []string{"anthropic", "deepseek"},
		Profiles: map[string]Profile{
			"anthropic": {
				Label:   "Anthropic",
				BaseURL: "",
				// Token (if any) is a `claude setup-token` OAuth token. Leave
				// it empty to just use the existing `claude login` session.
				TokenEnv: "CLAUDE_CODE_OAUTH_TOKEN",
				Env:      map[string]string{},
			},
			"deepseek": {
				Label:   "DeepSeek",
				BaseURL: "https://api.deepseek.com/anthropic",
				Env: map[string]string{
					"ANTHROPIC_MODEL":                "deepseek-v4-pro[1m]",
					"ANTHROPIC_DEFAULT_OPUS_MODEL":   "deepseek-v4-pro[1m]",
					"ANTHROPIC_DEFAULT_SONNET_MODEL": "deepseek-v4-pro[1m]",
					"ANTHROPIC_DEFAULT_HAIKU_MODEL":  "deepseek-v4-flash",
					"CLAUDE_CODE_SUBAGENT_MODEL":     "deepseek-v4-flash",
					"CLAUDE_CODE_EFFORT_LEVEL":       "max",
				},
			},
		},
	}
}

// Load returns the persisted config, seeding (and not yet writing) defaults
// when providers.json is absent. A nil Profiles map is normalised so callers
// can index safely.
func (s *Store) Load() (*Config, error) {
	p, err := providersPath()
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
	if c.Profiles == nil {
		c.Profiles = map[string]Profile{}
	}
	return &c, nil
}

// loadSecrets returns the token map (profile id → token). Absent file ⇒
// empty map.
func (s *Store) loadSecrets() (map[string]string, error) {
	p, err := secretsPath()
	if err != nil {
		return nil, err
	}
	b, err := os.ReadFile(p)
	if errors.Is(err, fs.ErrNotExist) {
		return map[string]string{}, nil
	}
	if err != nil {
		return nil, err
	}
	var m map[string]string
	if err := json.Unmarshal(b, &m); err != nil {
		return nil, err
	}
	if m == nil {
		m = map[string]string{}
	}
	return m, nil
}

// HasToken reports whether a non-empty token is stored for id.
func (s *Store) HasToken(id string) (bool, error) {
	m, err := s.loadSecrets()
	if err != nil {
		return false, err
	}
	return m[id] != "", nil
}

// saveConfig atomically writes providers.json (0644 — no secrets here).
func (s *Store) saveConfig(c *Config) error {
	p, err := providersPath()
	if err != nil {
		return err
	}
	return writeFileAtomic(p, c, 0o644)
}

// SetActive persists the active profile id. "" is accepted (passthrough).
// A non-empty id that names no profile is rejected so the UI can't strand
// the user on a phantom profile.
func (s *Store) SetActive(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	c, err := s.Load()
	if err != nil {
		return err
	}
	if id != "" {
		if _, ok := c.Profiles[id]; !ok {
			return errors.New("unknown provider profile: " + id)
		}
	}
	c.Active = id
	return s.saveConfig(c)
}

// SetToken stores (or clears, when token == "") the auth token for id in
// secrets.json (0600). The profile must exist.
func (s *Store) SetToken(id, token string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	c, err := s.Load()
	if err != nil {
		return err
	}
	if _, ok := c.Profiles[id]; !ok {
		return errors.New("unknown provider profile: " + id)
	}
	m, err := s.loadSecrets()
	if err != nil {
		return err
	}
	if token == "" {
		delete(m, id)
	} else {
		m[id] = token
	}
	p, err := secretsPath()
	if err != nil {
		return err
	}
	return writeFileAtomic(p, m, 0o600)
}

// Overlay computes the env overrides applied on top of the login-shell base
// for every spawned PTY. Semantics of the returned map:
//
//	value != ""  → set KEY=value
//	value == ""  → unset KEY (delete it from the child env)
//
// When no profile is active it returns nil (inject + strip nothing). For an
// active profile it sets that profile's BaseURL / Env / token AND clears
// every other key any profile manages, so switching DeepSeek → Anthropic
// doesn't leave stale DeepSeek vars (whether they came from a prior profile
// or the user's own shell rc) bleeding through.
func (s *Store) Overlay() map[string]string {
	c, err := s.Load()
	if err != nil || c.Active == "" {
		return nil
	}
	prof, ok := c.Profiles[c.Active]
	if !ok {
		return nil
	}

	// Managed key set: the base URL, every credential env var (so the active
	// profile's auth wins over any higher-precedence one in the shell rc),
	// every profile's chosen tokenEnv, and every env key declared by ANY
	// profile. These are the keys we own and clear when the active profile
	// doesn't set them.
	managed := map[string]bool{"ANTHROPIC_BASE_URL": true}
	for _, k := range authEnvVars {
		managed[k] = true
	}
	for _, p := range c.Profiles {
		managed[p.TokenEnvName()] = true
		for k := range p.Env {
			managed[k] = true
		}
	}

	out := make(map[string]string, len(managed))
	for k := range managed {
		out[k] = "" // default: clear
	}
	if prof.BaseURL != "" {
		out["ANTHROPIC_BASE_URL"] = prof.BaseURL
	}
	for k, v := range prof.Env {
		out[k] = v
	}
	if m, err := s.loadSecrets(); err == nil {
		if tok := m[c.Active]; tok != "" {
			out[prof.TokenEnvName()] = tok
		}
	}
	return out
}

// writeFileAtomic marshals v as indented JSON and writes it to path via a
// temp file + rename, creating the parent dir. perm is applied to the temp
// file so the final file (rename preserves mode) lands with the intended
// permissions — 0600 for secrets, 0644 otherwise.
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
