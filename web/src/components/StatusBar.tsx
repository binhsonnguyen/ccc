import { useEffect, useRef, useState } from 'react';
import { formatKeys } from '../lib/shortcuts';
import { getTerm } from '../lib/terminals';
import { THEME_NAMES, type ThemeName } from '../lib/themes';
import SplitMenu from './SplitMenu';
import type { Pane, TabStatus } from '../types';

interface Props {
  // Pane that drives the status bar — App passes the focused pane of
  // the active tab so the read-out tracks the user's eye.
  activeTab: Pane | null;
  // Bumped whenever a tab's status/cwd/uuid changes so dims/idle reset.
  // Not strictly needed (we poll), but it lets first-render show the
  // right dims right away on tab switch instead of waiting up to 1 s.
  pulse: number;
  onCopyCwd: (cwd: string) => void;
  themeName: ThemeName;
  onThemeChange: (n: ThemeName) => void;
  // Click handler for the cols×rows read-out. App opens the dims dialog.
  onOpenDims: () => void;
  // Split affordance lives here (not the TabBar) so it survives the
  // TabBar being hidden at 1 tab. canSplit = active tab has exactly 1
  // pane.
  canSplit: boolean;
  onSplitActive: (kind: 'claude' | 'shell' | 'bind') => void;
}

// Per-theme glyph + human label for the cycle button. Glyphs picked to
// be visually distinct: sun (light), moon (dark), half-moon (solarized).
const THEME_META: Record<ThemeName, { glyph: string; label: string }> = {
  dark:              { glyph: '☾', label: 'Dark' },
  light:             { glyph: '☀', label: 'Light' },
  'hc-dark':         { glyph: '◉', label: 'High Contrast Dark' },
  'hc-light':        { glyph: '◎', label: 'High Contrast Light' },
  'solarized-dark':  { glyph: '◐', label: 'Solarized Dark' },
  'solarized-light': { glyph: '◑', label: 'Solarized Light' },
};

// ThemeToggle opens a small popup menu listing the three themes with a
// checkmark on the active one — click to pick directly (no cycling).
// Rendered in both the full and empty status bar so it's reachable on
// the Welcome screen too. The palette and cheatsheet remain the
// keyboard paths. Menu opens upward (status bar is page-bottom).
function ThemeToggle({
  themeName,
  onThemeChange,
}: {
  themeName: ThemeName;
  onThemeChange: (n: ThemeName) => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const meta = THEME_META[themeName];

  // Close on outside click / Escape while open.
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

  return (
    <div className="statusbar-theme-wrap" ref={wrapRef}>
      <button
        type="button"
        className="statusbar-theme"
        onClick={() => setOpen((v) => !v)}
        title={`Theme: ${meta.label}`}
        aria-label={`Theme: ${meta.label}. Click to choose a theme.`}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <span className="statusbar-theme-glyph" aria-hidden="true">{meta.glyph}</span>
        {meta.label}
      </button>
      {open && (
        <div className="row-menu statusbar-theme-menu" role="menu">
          {THEME_NAMES.map((n) => {
            const m = THEME_META[n];
            const active = n === themeName;
            return (
              <button
                key={n}
                type="button"
                role="menuitemradio"
                aria-checked={active}
                className="row-menu-item"
                onClick={() => {
                  onThemeChange(n);
                  setOpen(false);
                }}
              >
                <span>
                  <span className="statusbar-theme-glyph" aria-hidden="true">{m.glyph}</span>
                  {' '}{m.label}
                </span>
                <span aria-hidden="true">{active ? '✓' : ''}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

// Smart truncate: homedir → ~, then middle-ellipsis if still > maxLen.
// We don't know HOME on the client, but Claude entries use absolute
// paths with /Users/<name>/... — collapsing /Users/<name> to ~ matches
// what every shell does and keeps the bar readable on a 1280px window.
function shortenCwd(cwd: string, maxLen = 60): string {
  if (!cwd) return '';
  let s = cwd;
  const userMatch = s.match(/^\/Users\/[^/]+/);
  const homeMatch = s.match(/^\/home\/[^/]+/);
  if (userMatch) s = '~' + s.slice(userMatch[0].length);
  else if (homeMatch) s = '~' + s.slice(homeMatch[0].length);
  if (s.length <= maxLen) return s;
  // Middle-ellipsis at path boundary: keep first segment + last 2.
  const parts = s.split('/');
  if (parts.length < 4) {
    const half = Math.max(8, (maxLen - 1) / 2);
    return s.slice(0, half) + '…' + s.slice(s.length - half);
  }
  const head = parts.slice(0, 2).join('/');
  const tail = parts.slice(-2).join('/');
  return `${head}/…/${tail}`;
}

// Format "how long since the current status started" — not "session
// idle". We don't have an activity firehose yet, so saying "12s ago"
// would imply session-idle that we can't back up. Pair with the
// "status" prefix at the render site. See PR-4 review C4.
function formatAge(ms: number): string {
  if (ms < 1000) return '<1s';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

const STATE_LABEL: Record<TabStatus, string> = {
  connecting: 'connecting',
  pending: 'pending',
  connected: 'live',
  disconnected: 'disconnected',
  kicked: 'kicked',
  exited: 'exited',
  error: 'error',
};

export default function StatusBar({ activeTab, pulse, onCopyCwd, themeName, onThemeChange, onOpenDims, canSplit, onSplitActive }: Props) {
  // 1 Hz tick drives both the dims read-out and idle counter without
  // forcing a render every WS frame. Cheap and keeps the bar quiet.
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setTick((n) => n + 1), 1000);
    return () => window.clearInterval(id);
  }, []);

  // Track first-seen timestamp for the current uuid. We don't have a
  // global WS event firehose to subscribe to here, so "idle" here means
  // "time since the tab acquired its current status" — close enough for
  // an at-a-glance hint and avoids reaching into terminals.ts internals.
  const [statusSince, setStatusSince] = useState<{ uuid: string; t: number }>({
    uuid: '',
    t: Date.now(),
  });
  useEffect(() => {
    if (!activeTab) return;
    setStatusSince((prev) => {
      if (prev.uuid === activeTab.claudeUuid) return prev;
      return { uuid: activeTab.claudeUuid, t: Date.now() };
    });
    // pulse intentionally included: a status flip resets idle so the
    // user sees "connected · <1s ago" the instant ready arrives.
  }, [activeTab, pulse]);

  if (!activeTab) {
    return (
      <footer className="statusbar statusbar-empty" aria-label="Status bar">
        <span className="statusbar-empty-label">No active tab</span>
        <div className="statusbar-right">
          <SplitMenu canSplit={canSplit} onSplitActive={onSplitActive} />
          <span className="statusbar-sep" aria-hidden="true">·</span>
          <ThemeToggle themeName={themeName} onThemeChange={onThemeChange} />
        </div>
      </footer>
    );
  }

  const entry = getTerm(activeTab.claudeUuid);
  const cols = entry?.term.cols ?? 0;
  const rows = entry?.term.rows ?? 0;
  const dims = activeTab.status === 'connected' && cols && rows
    ? `${cols}×${rows}`
    : null;
  const idleMs = Date.now() - statusSince.t;
  const stateClass = `status-${activeTab.status}`;
  const cwdShort = shortenCwd(activeTab.cwd || '');
  const uuidShort = activeTab.claudeUuid.slice(0, 8);

  return (
    <footer className="statusbar" aria-label="Status bar">
      <div className="statusbar-left">
        {cwdShort ? (
          <button
            type="button"
            className="statusbar-cwd"
            title={activeTab.cwd}
            onClick={() => onCopyCwd(activeTab.cwd)}
            aria-label={`Copy working directory: ${activeTab.cwd}`}
          >
            <span className="statusbar-cwd-icon" aria-hidden="true">⏵</span>
            {cwdShort}
          </button>
        ) : (
          <span className="statusbar-cwd" aria-hidden="true">
            <span className="statusbar-cwd-icon">⏵</span>—
          </span>
        )}
      </div>

      <div className="statusbar-center">
        <span className="statusbar-state">
          <span
            className={`statusbar-state-dot ${stateClass}`}
            aria-hidden="true"
          />
          {STATE_LABEL[activeTab.status]}
        </span>
        {dims && (
          <>
            <span className="statusbar-sep" aria-hidden="true">·</span>
            <button
              type="button"
              className="statusbar-dims"
              aria-label={`Terminal dimensions ${dims}. Click to configure.`}
              title="Configure max cols / rows"
              onClick={onOpenDims}
            >
              {dims}
            </button>
          </>
        )}
      </div>

      <div className="statusbar-right">
        <SplitMenu canSplit={canSplit} onSplitActive={onSplitActive} />
        <span className="statusbar-sep" aria-hidden="true">·</span>
        <span className="statusbar-uuid" title={activeTab.claudeUuid}>
          id {uuidShort}
        </span>
        <span className="statusbar-sep" aria-hidden="true">·</span>
        <span className="statusbar-idle" aria-label="status age">
          status {formatAge(idleMs)}
        </span>
        <span className="statusbar-sep" aria-hidden="true">·</span>
        <kbd title="Command palette (coming soon)">
          {formatKeys('Mod+k')}
        </kbd>
        <span className="statusbar-sep" aria-hidden="true">·</span>
        <ThemeToggle themeName={themeName} onThemeChange={onThemeChange} />
      </div>
    </footer>
  );
}
