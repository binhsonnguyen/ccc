import { useCallback, useEffect, useRef, useState } from 'react';
import {
  getProviders,
  setActiveProvider,
  setProviderToken,
  type ProviderProfile,
} from '../lib/api';

// ProviderToggle is the status-bar control for switching the active LLM
// backend (Anthropic / DeepSeek / …) and storing each provider's long-lived
// auth token. It mirrors ThemeToggle's upward popover pattern.
//
// The active profile is GLOBAL and applies to sessions started AFTER the
// switch — already-running PTYs keep their spawn-time env (claude reads
// ANTHROPIC_* only at launch). The popover says so explicitly.
//
// The empty-id pseudo-profile "System (shell env)" means passthrough: c3
// injects nothing, so claude sees exactly the login-shell environment (the
// behaviour before this feature existed).
export default function ProviderToggle() {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState('');
  const [profiles, setProfiles] = useState<ProviderProfile[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  // Per-profile token draft + a transient "saved" flash.
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState<string>('');
  const wrapRef = useRef<HTMLDivElement | null>(null);

  const refresh = useCallback(async () => {
    try {
      const r = await getProviders();
      setActive(r.active);
      setProfiles(r.profiles);
      setErr('');
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, []);

  // Load once on mount so the button shows the right label, and again each
  // time the popover opens so hasToken flags stay fresh across windows.
  useEffect(() => {
    void refresh();
  }, [refresh]);
  useEffect(() => {
    if (open) void refresh();
  }, [open, refresh]);

  // Close on outside click / Escape.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const activeLabel =
    active === ''
      ? 'System'
      : profiles.find((p) => p.id === active)?.label ?? active;

  const pickActive = async (id: string) => {
    setBusy(true);
    try {
      await setActiveProvider(id);
      setActive(id);
      setErr('');
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const saveToken = async (id: string) => {
    const token = drafts[id] ?? '';
    setBusy(true);
    try {
      await setProviderToken(id, token);
      setDrafts((d) => ({ ...d, [id]: '' }));
      setSaved(id);
      window.setTimeout(() => setSaved(''), 1500);
      await refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="statusbar-provider-wrap" ref={wrapRef}>
      <button
        type="button"
        className="statusbar-provider"
        onClick={() => setOpen((v) => !v)}
        title={`LLM provider: ${activeLabel}. Click to switch / set tokens.`}
        aria-label={`LLM provider: ${activeLabel}. Click to switch or set tokens.`}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <span className="statusbar-provider-glyph" aria-hidden="true">
          ⚡
        </span>
        {activeLabel}
      </button>
      {open && (
        <div className="row-menu statusbar-provider-menu" role="menu">
          <div className="statusbar-provider-hint">
            Applies to new sessions only
          </div>
          <button
            type="button"
            role="menuitemradio"
            aria-checked={active === ''}
            className="row-menu-item"
            disabled={busy}
            onClick={() => void pickActive('')}
          >
            <span>System (shell env)</span>
            <span aria-hidden="true">{active === '' ? '✓' : ''}</span>
          </button>
          {profiles.map((p) => (
            <div key={p.id} className="statusbar-provider-row">
              <button
                type="button"
                role="menuitemradio"
                aria-checked={active === p.id}
                className="row-menu-item"
                disabled={busy}
                onClick={() => void pickActive(p.id)}
              >
                <span>
                  {p.label}
                  {p.hasToken && (
                    <span className="statusbar-provider-tokchip" title="Token stored">
                      {' '}token ✓
                    </span>
                  )}
                </span>
                <span aria-hidden="true">{active === p.id ? '✓' : ''}</span>
              </button>
              <div className="statusbar-provider-token">
                <input
                  type="password"
                  className="statusbar-provider-input"
                  placeholder={p.hasToken ? 'replace token…' : 'set auth token…'}
                  value={drafts[p.id] ?? ''}
                  autoComplete="off"
                  onChange={(e) =>
                    setDrafts((d) => ({ ...d, [p.id]: e.target.value }))
                  }
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void saveToken(p.id);
                  }}
                />
                <button
                  type="button"
                  className="statusbar-provider-save"
                  disabled={busy || (drafts[p.id] ?? '') === ''}
                  onClick={() => void saveToken(p.id)}
                >
                  {saved === p.id ? 'saved' : 'save'}
                </button>
              </div>
            </div>
          ))}
          {err && <div className="statusbar-provider-err">{err}</div>}
        </div>
      )}
    </div>
  );
}
