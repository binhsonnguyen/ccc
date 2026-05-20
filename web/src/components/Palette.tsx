// Command palette (PLAN.md P-1).
//
// Mounts in App on demand. One source of truth for "what can I do right
// now" — sessions to open, tabs to switch to, and named actions. The
// fuzzy matcher is intentionally tiny (~30 LoC) so we don't drag a dep
// for ~100 items; bonus weighting matches the usual fzf intuition
// (prefix, word boundary, consecutive run) closely enough for taste.
//
// Bucket A modal contract: createPortal to body, focus trap (Tab cycles
// inside), ESC closes, restore focus on unmount, role=dialog. ESC is
// routed through the shortcut registry with a `when` predicate so it
// fires regardless of whether the search input or a result row is
// focused — semantically Esc means "leave palette", not "clear input".

import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { formatKeys, useShortcut } from '../lib/shortcuts';
import type { ThemeName } from '../lib/themes';
import type { C3Entry, Tab } from '../types';

export interface PaletteActions {
  refresh: () => void;
  toggleSidebar: () => void;
  openNewSession: () => void;
  setView: (v: 'active' | 'archived') => void;
  closeTab: (uuid: string) => void;
  killTab: (uuid: string) => void;
  closeAllTabs: () => void;
  archiveActive: () => void;
  copyCwd: (cwd: string) => void;
  openCheatsheet: () => void;
  // Theme switcher entries appear as palette actions so the only
  // discoverable surface for "change theme" is Mod+K → "theme" (the
  // cheatsheet footer still works as a click target for keyboard-shy
  // users, but typing is faster).
  setTheme: (n: ThemeName) => void;
}

interface Props {
  open: boolean;
  onClose: () => void;
  sessions: C3Entry[] | null;
  tabs: Tab[];
  activeUuid: string | null;
  view: 'active' | 'archived';
  themeName: ThemeName;
  onOpenSession: (entry: C3Entry) => void;
  onSwitchTab: (uuid: string) => void;
  actions: PaletteActions;
}

type Group = 'Sessions' | 'Tabs' | 'Actions';

interface Item {
  id: string;
  group: Group;
  label: string;
  detail?: string;
  hint?: string; // formatted key hint, right-aligned
  score: number;
  run: () => void;
}

// fuzzyMatch: returns 0 = no match, higher = better. Characters of
// `query` must appear in `target` in order, case-insensitive. We award:
//   +10 if the match starts at position 0 (prefix)
//   + 3 per character that lands on a word boundary (/, space, -, _, .)
//   + 5 per consecutive-with-previous match
//   + 1 case-exact bonus per char
// and subtract `firstIdx + gaps` so tighter matches near the start win.
function fuzzyMatch(query: string, target: string): number {
  if (!query) return 1; // empty query matches everything with baseline score
  if (!target) return 0;
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  let ti = 0;
  let qi = 0;
  let score = 0;
  let firstIdx = -1;
  let prevMatchIdx = -2;
  let gaps = 0;
  while (qi < q.length && ti < t.length) {
    if (q[qi] === t[ti]) {
      if (firstIdx < 0) firstIdx = ti;
      if (ti === prevMatchIdx + 1) score += 5;
      const prev = ti === 0 ? '' : t[ti - 1];
      if (ti === 0 || prev === ' ' || prev === '/' || prev === '-' || prev === '_' || prev === '.') {
        score += 3;
      }
      if (target[ti] === query[qi]) score += 1;
      prevMatchIdx = ti;
      qi++;
    } else if (prevMatchIdx >= 0) {
      gaps++;
    }
    ti++;
  }
  if (qi < q.length) return 0;
  if (firstIdx === 0) score += 10;
  score += 50 - Math.min(50, firstIdx + gaps);
  return Math.max(1, score);
}

const SESS_LIMIT = 8;
const TAB_LIMIT = 8;
const ACT_LIMIT = 12;

export default function Palette({
  open,
  onClose,
  sessions,
  tabs,
  activeUuid,
  view,
  themeName,
  onOpenSession,
  onSwitchTab,
  actions,
}: Props) {
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  // Reset query+cursor on open. Capture previous focus before we steal it.
  useEffect(() => {
    if (!open) return;
    previouslyFocused.current = document.activeElement as HTMLElement | null;
    setQuery('');
    setCursor(0);
    // microtask so the input exists in the DOM
    queueMicrotask(() => inputRef.current?.focus());
    return () => {
      previouslyFocused.current?.focus?.();
    };
  }, [open]);

  // Tab focus-trap inside the modal. Tab key by itself also closes (per
  // spec "user wants to leave") — but we keep arrow + enter focused on
  // the search input always. So we just intercept Tab → close.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Tab') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  // ESC via registry — fires even when the input has focus, because the
  // registry dispatches based on registered entries, not on activeElement
  // tag. `when` gates to open-state so closed palette doesn't swallow ESC
  // from e.g. the new-session form.
  useShortcut(
    {
      id: 'palette.close',
      keys: 'Escape',
      scope: 'global',
      label: 'Close command palette',
      when: () => open,
      handler: () => onClose(),
    },
    [open, onClose],
  );

  // Build the item list. Memoized on inputs so typing doesn't re-walk
  // for unchanged data.
  const items = useMemo<Item[]>(() => {
    if (!open) return [];
    const q = query.trim();
    const out: Item[] = [];

    // Sessions
    const sessList: Item[] = [];
    if (sessions) {
      for (const s of sessions) {
        const hay = (s.name || '') + ' ' + (s.cwd || '');
        const score = fuzzyMatch(q, hay);
        if (score <= 0) continue;
        sessList.push({
          id: 'sess:' + s.id,
          group: 'Sessions',
          label: s.name || s.id,
          detail: s.cwd,
          score,
          run: () => onOpenSession(s),
        });
      }
    }
    sessList.sort((a, b) => b.score - a.score);
    out.push(...sessList.slice(0, SESS_LIMIT));

    // Tabs (only meaningful in open state — switch vs open differs)
    const tabList: Item[] = [];
    for (const t of tabs) {
      const hay = '[tab] ' + (t.name || '') + ' ' + (t.cwd || '');
      const score = fuzzyMatch(q, hay);
      if (score <= 0) continue;
      tabList.push({
        id: 'tab:' + t.claudeUuid,
        group: 'Tabs',
        label: '[tab] ' + (t.name || t.c3Id),
        detail: t.cwd,
        score,
        run: () => onSwitchTab(t.claudeUuid),
      });
    }
    tabList.sort((a, b) => b.score - a.score);
    out.push(...tabList.slice(0, TAB_LIMIT));

    // Actions
    const activeTab = tabs.find((t) => t.claudeUuid === activeUuid) ?? null;
    const activeSess = activeTab
      ? sessions?.find((s) => s.id === activeTab.c3Id) ?? null
      : null;
    type ActionDef = { label: string; hint?: string; when?: boolean; run: () => void };
    const acts: ActionDef[] = [
      { label: 'Refresh sessions', hint: '', run: actions.refresh },
      { label: 'Toggle sidebar', hint: 'Mod+b', run: actions.toggleSidebar },
      { label: 'New session', run: actions.openNewSession },
      {
        label: view === 'active' ? 'Switch view: Archived' : 'Switch view: Active',
        run: () => actions.setView(view === 'active' ? 'archived' : 'active'),
      },
      {
        label: 'Close active tab',
        hint: 'Delete',
        when: !!activeTab,
        run: () => activeTab && actions.closeTab(activeTab.claudeUuid),
      },
      {
        label: 'Kill active tab',
        when: !!activeTab,
        run: () => activeTab && actions.killTab(activeTab.claudeUuid),
      },
      {
        label: 'Close all tabs',
        when: tabs.length > 0,
        run: actions.closeAllTabs,
      },
      {
        label: activeSess && view === 'archived' ? 'Unarchive active session' : 'Archive active session',
        when: !!activeSess,
        run: actions.archiveActive,
      },
      {
        label: 'Copy active cwd',
        when: !!(activeTab && activeTab.cwd),
        run: () => activeTab && actions.copyCwd(activeTab.cwd),
      },
      { label: 'Show keyboard shortcuts', hint: '?', run: actions.openCheatsheet },
      // Theme switchers. The current theme is omitted (no reason to
      // "switch" to what you already have) so the only visible entries
      // are the ones a click actually changes.
      ...(
        [
          { name: 'dark' as const,             label: 'Theme: Dark' },
          { name: 'light' as const,            label: 'Theme: Light' },
          { name: 'solarized-dark' as const,   label: 'Theme: Solarized Dark' },
          { name: 'hc-dark' as const,          label: 'Theme: High Contrast Dark' },
          { name: 'hc-light' as const,         label: 'Theme: High Contrast Light' },
          { name: 'solarized-light' as const,  label: 'Theme: Solarized Light' },
        ]
          .filter((t) => t.name !== themeName)
          .map((t) => ({ label: t.label, run: () => actions.setTheme(t.name) }))
      ),
    ];
    const actList: Item[] = [];
    for (const a of acts) {
      if (a.when === false) continue;
      const score = fuzzyMatch(q, a.label);
      if (score <= 0) continue;
      actList.push({
        id: 'act:' + a.label,
        group: 'Actions',
        label: a.label,
        hint: a.hint ? formatKeys(a.hint) : undefined,
        score,
        run: a.run,
      });
    }
    actList.sort((a, b) => b.score - a.score);
    out.push(...actList.slice(0, ACT_LIMIT));

    return out;
  }, [open, query, sessions, tabs, activeUuid, view, onOpenSession, onSwitchTab, actions]);

  // Clamp cursor when items change.
  useEffect(() => {
    if (cursor >= items.length) setCursor(Math.max(0, items.length - 1));
  }, [items, cursor]);

  // Scroll highlighted into view.
  useEffect(() => {
    if (!open) return;
    const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${cursor}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [cursor, open]);

  if (!open) return null;

  const runAt = (idx: number) => {
    const it = items[idx];
    if (!it) return;
    // Close *before* running so action callbacks (which may toggle App
    // state) see the palette already closed and previously-focused
    // restoration doesn't fight a follow-on focus from the action.
    onClose();
    queueMicrotask(it.run);
  };

  const onInputKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setCursor((c) => (items.length === 0 ? 0 : (c + 1) % items.length));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setCursor((c) => (items.length === 0 ? 0 : (c - 1 + items.length) % items.length));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      runAt(cursor);
    }
  };

  // Render with group headers inserted before the first item of each group.
  const rows: React.ReactNode[] = [];
  let lastGroup: Group | null = null;
  items.forEach((it, idx) => {
    if (it.group !== lastGroup) {
      rows.push(
        <div className="palette-group" key={'g:' + it.group}>
          {it.group}
        </div>,
      );
      lastGroup = it.group;
    }
    const active = idx === cursor;
    rows.push(
      <div
        key={it.id}
        data-idx={idx}
        className={'palette-item' + (active ? ' active' : '')}
        role="option"
        aria-selected={active}
        onMouseEnter={() => setCursor(idx)}
        onMouseDown={(e) => {
          // mousedown so input blur doesn't fire first and unmount us
          e.preventDefault();
          runAt(idx);
        }}
      >
        <div className="palette-item-main">
          <div className="palette-item-label">{it.label}</div>
          {it.detail && <div className="palette-item-detail">{it.detail}</div>}
        </div>
        {it.hint && <div className="palette-item-hint">{it.hint}</div>}
      </div>,
    );
  });

  return createPortal(
    <div
      className="overlay overlay-fixed palette-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Command palette"
      onMouseDown={(e) => {
        // Click outside the card closes.
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div ref={rootRef} className="palette-card">
        <div className="palette-search">
          <span className="palette-search-icon" aria-hidden="true">⌕</span>
          <input
            ref={inputRef}
            type="text"
            className="palette-input"
            placeholder="Type a command or session…"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setCursor(0);
            }}
            onKeyDown={onInputKey}
            spellCheck={false}
            aria-label="Command palette search"
            aria-autocomplete="list"
          />
        </div>
        <div ref={listRef} className="palette-list" role="listbox">
          {items.length === 0 ? (
            <div className="palette-empty">No matches.</div>
          ) : (
            rows
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
