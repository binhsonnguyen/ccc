// Shortcuts cheatsheet (PLAN.md P-2).
//
// Reads from the shortcut registry (listShortcuts) so adding a binding
// anywhere auto-updates this panel — no separate doc to maintain. We
// filter to entries with a non-empty `label`, dedupe by label (two
// arrow-key bindings for the same action register as separate entries),
// and group by `scope`.
//
// Modal contract mirrors NewSessionForm: portal to body, focus trap on
// Tab, ESC closes via the registry (gated by open-state), restore focus
// on unmount, role=dialog.

import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { formatKeys, listShortcuts, useShortcut, type ShortcutScope } from '../lib/shortcuts';
import type { ThemeName } from '../lib/themes';

interface Props {
  open: boolean;
  onClose: () => void;
  themeName: ThemeName;
  onThemeChange: (n: ThemeName) => void;
}

const THEME_OPTIONS: Array<{ name: ThemeName; label: string }> = [
  { name: 'dark',             label: 'Dark' },
  { name: 'light',            label: 'Light' },
  { name: 'hc-dark',          label: 'HC Dark' },
  { name: 'hc-light',         label: 'HC Light' },
  { name: 'solarized-dark',   label: 'Solarized Dark' },
  { name: 'solarized-light',  label: 'Solarized Light' },
];

const SCOPE_LABEL: Record<ShortcutScope, string> = {
  global: 'Global',
  'tab-focused': 'Tab bar',
  'sidebar-focused': 'Sidebar',
  'menu-focused': 'Menu',
};
const SCOPE_ORDER: ShortcutScope[] = ['global', 'tab-focused', 'sidebar-focused', 'menu-focused'];

interface Row {
  label: string;
  keys: string[]; // multiple keys collapse into one row if same label
}

export default function Cheatsheet({ open, onClose, themeName, onThemeChange }: Props) {
  const [filter, setFilter] = useState('');
  const inputRef = useRef<HTMLInputElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    previouslyFocused.current = document.activeElement as HTMLElement | null;
    setFilter('');
    queueMicrotask(() => inputRef.current?.focus());
    return () => {
      previouslyFocused.current?.focus?.();
    };
  }, [open]);

  // Focus trap on Tab.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Tab' || !rootRef.current) return;
      const focusables = rootRef.current.querySelectorAll<HTMLElement>(
        'button, input, [tabindex]:not([tabindex="-1"])',
      );
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  useShortcut(
    {
      id: 'cheatsheet.close',
      keys: 'Escape',
      scope: 'global',
      label: 'Close shortcuts cheatsheet',
      when: () => open,
      handler: () => onClose(),
    },
    [open, onClose],
  );

  // Snapshot the registry whenever we open. Registry contents change as
  // components mount/unmount; reading on every render would be fine but
  // memoizing keeps the row math cheap when typing into the filter.
  const groups = useMemo(() => {
    if (!open) return [] as Array<{ scope: ShortcutScope; rows: Row[] }>;
    const all = listShortcuts().filter((s) => s.label && s.label.trim().length > 0);
    // Dedupe by `scope + label`, collecting all keys into one row. Two
    // entries with the same label (e.g. ArrowLeft + ArrowRight both
    // "Toggle Active / Archived") collapse so the cheatsheet doesn't
    // list the action twice.
    const buckets = new Map<ShortcutScope, Map<string, string[]>>();
    for (const e of all) {
      let bucket = buckets.get(e.scope);
      if (!bucket) {
        bucket = new Map();
        buckets.set(e.scope, bucket);
      }
      const existing = bucket.get(e.label);
      if (existing) {
        if (!existing.includes(e.keys)) existing.push(e.keys);
      } else {
        bucket.set(e.label, [e.keys]);
      }
    }
    const out: Array<{ scope: ShortcutScope; rows: Row[] }> = [];
    for (const scope of SCOPE_ORDER) {
      const bucket = buckets.get(scope);
      if (!bucket || bucket.size === 0) continue;
      const rows: Row[] = [];
      for (const [label, keys] of bucket.entries()) {
        rows.push({ label, keys });
      }
      rows.sort((a, b) => a.label.localeCompare(b.label));
      out.push({ scope, rows });
    }
    return out;
  }, [open]);

  const q = filter.trim().toLowerCase();
  const filtered = useMemo(() => {
    if (!q) return groups;
    return groups
      .map((g) => ({
        scope: g.scope,
        rows: g.rows.filter(
          (r) =>
            r.label.toLowerCase().includes(q) ||
            r.keys.some((k) => formatKeys(k).toLowerCase().includes(q) || k.toLowerCase().includes(q)),
        ),
      }))
      .filter((g) => g.rows.length > 0);
  }, [groups, q]);

  if (!open) return null;

  return createPortal(
    <div
      className="overlay overlay-fixed palette-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Keyboard shortcuts"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div ref={rootRef} className="cheatsheet-card">
        <div className="cheatsheet-header">
          <h2>Keyboard shortcuts</h2>
          <button
            type="button"
            className="cheatsheet-close"
            onClick={onClose}
            aria-label="Close"
          >
            ×
          </button>
        </div>
        <div className="palette-search">
          <span className="palette-search-icon" aria-hidden="true">⌕</span>
          <input
            ref={inputRef}
            type="text"
            className="palette-input"
            placeholder="filter…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            spellCheck={false}
            aria-label="Filter shortcuts"
          />
        </div>
        <div className="cheatsheet-body">
          {filtered.length === 0 ? (
            <div className="palette-empty">No shortcuts match.</div>
          ) : (
            filtered.map((g) => (
              <div className="cheatsheet-group" key={g.scope}>
                <div className="palette-group">{SCOPE_LABEL[g.scope]}</div>
                {g.rows.map((r) => (
                  <div className="cheatsheet-row" key={r.label}>
                    <div className="cheatsheet-keys">
                      {r.keys.map((k, i) => (
                        <span key={k}>
                          {i > 0 && <span className="cheatsheet-or"> / </span>}
                          {k.split('+').map((part, j, arr) => (
                            <span key={j}>
                              <kbd className="kbd">{formatKeys(part)}</kbd>
                              {j < arr.length - 1 && <span className="kbd-plus">+</span>}
                            </span>
                          ))}
                        </span>
                      ))}
                    </div>
                    <div className="cheatsheet-label">{r.label}</div>
                  </div>
                ))}
              </div>
            ))
          )}
        </div>
        <div className="cheatsheet-footer" role="radiogroup" aria-label="Theme">
          <span className="cheatsheet-footer-label">Theme</span>
          <div className="cheatsheet-theme-switch">
            {THEME_OPTIONS.map((opt) => (
              <button
                key={opt.name}
                type="button"
                role="radio"
                aria-checked={themeName === opt.name}
                className={
                  'btn btn-sm cheatsheet-theme-btn' +
                  (themeName === opt.name ? ' is-active' : '')
                }
                onClick={() => onThemeChange(opt.name)}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
