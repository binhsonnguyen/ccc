import { useCallback, useEffect, useRef, useState } from 'react';
import SessionRowMenu, { type MenuItem } from './SessionRowMenu';
import NewSessionForm from './NewSessionForm';
import SessionPreview from './SessionPreview';
import Sparkline from './Sparkline';
import {
  ApiError,
  archiveSession,
  fetchActivity,
  fetchSessionTail,
  renameSession,
  removeSession,
  searchSessions,
  type SearchMatch,
} from '../lib/api';
import { useShortcut } from '../lib/shortcuts';
import { cwdMonogram, cwdTint, cwdTintFg } from '../lib/cwdTint';
import type { C3Entry, Tab } from '../types';

export type SidebarView = 'active' | 'archived';

interface Props {
  // null = initial load in flight (Sidebar renders skeleton). [] = loaded
  // but empty. Array = loaded with entries.
  sessions: C3Entry[] | null;
  activeUuid: string | null;
  openTabs: Tab[];
  view: SidebarView;
  onViewChange: (v: SidebarView) => void;
  onOpen: (entry: C3Entry) => void;
  onRefresh: () => void;
  onSessionSelected?: () => void;
  // After mutating operations we ask App to refresh the list and maybe
  // close a tab (remove path closes the open tab if it matched the
  // removed entry).
  onAfterMutate: () => void;
  onCloseTabFor: (uuid: string) => void;
  // Drawer mode flag for the new-session form fallback.
  narrow: boolean;
  showToast: (
    msg: string,
    opts?: { variant?: 'info' | 'error' | 'warning' | 'success' },
  ) => void;
  // Counter from App: each increment is a request from Welcome (or any
  // other component) to open the inline new-session form. Effect below
  // watches it via dependency array.
  openNewSessionTick?: number;
  // B-3: width control. App owns the value (persists to localStorage),
  // Sidebar owns the drag interaction.
  width: number;
  onWidthChange: (w: number) => void;
  // Drawer mode hides the handle (sidebar is fixed-position 280px).
  resizable: boolean;
}

const SIDEBAR_W_MIN = 200;
const SIDEBAR_W_MAX = 480;
const SIDEBAR_W_DEFAULT = 280;
const clampWidth = (w: number) =>
  Math.max(SIDEBAR_W_MIN, Math.min(SIDEBAR_W_MAX, Math.round(w)));

interface MenuState {
  rowId: string;
  x: number;
  y: number;
}

interface PreviewState {
  rowId: string;
  rect: DOMRect;
  text: string | null; // null = loading
}

// Module-level cache so hover → leave → hover doesn't re-fetch within
// 5 s. Keyed by c3 id; value is the raw text body the server returned
// (still containing ANSI — stripping happens in the component).
const TAIL_TTL_MS = 5000;
const tailCache = new Map<string, { text: string; at: number }>();
function getCachedTail(id: string): string | null {
  const hit = tailCache.get(id);
  if (!hit) return null;
  if (Date.now() - hit.at > TAIL_TTL_MS) {
    tailCache.delete(id);
    return null;
  }
  return hit.text;
}
function setCachedTail(id: string, text: string) {
  tailCache.set(id, { text, at: Date.now() });
}

const HOVER_DELAY_MS = 600;
const DISMISS_DELAY_MS = 200;

// C-1: per-row activity cache. Same idea as the tail cache but with a
// shorter TTL (1.5 s) — the sparkline polls every 2 s so a single
// in-flight result should not be re-fetched by a sibling re-render
// in the meantime. Polling itself is gated by document visibility +
// a 30-row cap so a giant sidebar doesn't hammer the server.
interface ActivityCacheEntry {
  buckets: number[] | null;
  at: number;
}
const ACTIVITY_POLL_MS = 2000;
// TTL slightly under the poll period so a tick that runs a hair late
// still hits the cache, but every poll *does* re-fetch (otherwise
// what's the point of polling). Used by sibling renders within the
// same window too.
const ACTIVITY_TTL_MS = ACTIVITY_POLL_MS - 100;
const ACTIVITY_MAX_ROWS = 30;
const activityCache = new Map<string, ActivityCacheEntry>();
function getCachedActivity(id: string): number[] | null | undefined {
  const hit = activityCache.get(id);
  if (!hit) return undefined;
  if (Date.now() - hit.at > ACTIVITY_TTL_MS) return undefined;
  return hit.buckets;
}
function setCachedActivity(id: string, buckets: number[] | null) {
  activityCache.set(id, { buckets, at: Date.now() });
}

// Cheap structural compare for two bucket arrays (or nulls). Returns
// true when the sparkline would render identically — used to skip
// React state updates that would otherwise rerender 30 rows on every
// poll even when nothing changed.
function buckets_eq(
  a: number[] | null | undefined,
  b: number[] | null | undefined,
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export default function Sidebar({
  sessions,
  activeUuid,
  openTabs,
  view,
  onViewChange,
  onOpen,
  onRefresh,
  onSessionSelected,
  onAfterMutate,
  onCloseTabFor,
  narrow,
  showToast,
  openNewSessionTick,
  width,
  onWidthChange,
  resizable,
}: Props) {
  // Resize drag state. We don't put `dragging` in React state (would
  // rerender on every mouse move); we mark the DOM with a class for the
  // visual feedback instead.
  const dragStartRef = useRef<{ x: number; w: number } | null>(null);
  const resizerRef = useRef<HTMLDivElement | null>(null);

  const onResizerMouseDown = (e: React.MouseEvent) => {
    if (!resizable) return;
    e.preventDefault();
    dragStartRef.current = { x: e.clientX, w: width };
    resizerRef.current?.classList.add('dragging');
    document.body.style.cursor = 'col-resize';
    // Prevent text-selection flicker during drag.
    document.body.style.userSelect = 'none';
    const onMove = (ev: MouseEvent) => {
      const start = dragStartRef.current;
      if (!start) return;
      const next = clampWidth(start.w + (ev.clientX - start.x));
      onWidthChange(next);
    };
    const onUp = () => {
      dragStartRef.current = null;
      resizerRef.current?.classList.remove('dragging');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };
  const onResizerDblClick = () => {
    if (!resizable) return;
    onWidthChange(SIDEBAR_W_DEFAULT);
  };
  const onResizerKeyDown = (e: React.KeyboardEvent) => {
    if (!resizable) return;
    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      onWidthChange(clampWidth(width - 10));
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      onWidthChange(clampWidth(width + 10));
    } else if (e.key === 'Home') {
      e.preventDefault();
      onWidthChange(SIDEBAR_W_MIN);
    } else if (e.key === 'End') {
      e.preventDefault();
      onWidthChange(SIDEBAR_W_MAX);
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onWidthChange(SIDEBAR_W_DEFAULT);
    }
  };
  const openSet = new Set(openTabs.map((t) => t.claudeUuid));
  const [menu, setMenu] = useState<MenuState | null>(null);
  // Filter (B-2). Local + transient: not persisted across reloads — the
  // sidebar's job is to surface sessions, not remember a search.
  const [filter, setFilter] = useState('');
  const filterInputRef = useRef<HTMLInputElement | null>(null);
  // Deep search (full-text JSONL grep). State machine:
  //   idle       — q<3 chars, or no deep-search requested
  //   loading    — request in flight
  //   results    — array (possibly empty)
  //   error      — fetch failed
  // `searchForced` is set true when the user clicks "Search messages…"
  // so we run the query even when there ARE name matches.
  const [searchState, setSearchState] = useState<
    | { kind: 'idle' }
    | { kind: 'loading' }
    | { kind: 'results'; matches: SearchMatch[]; truncated: boolean; q: string }
    | { kind: 'error'; message: string }
  >({ kind: 'idle' });
  const [searchForced, setSearchForced] = useState(false);
  // Token guards against stale responses: incremented on every new query,
  // each fetch captures its token and discards itself if outdated.
  const searchTokenRef = useRef(0);
  const searchAbortRef = useRef<AbortController | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  // Set transiently when Esc dismisses the rename input; blur fires after
  // unmount and would otherwise commit the draft (PATCH). Read+reset in
  // commitRename. ref (not state) because commitRename is called in the
  // same tick as the unmount/blur sequence.
  const renameCancelledRef = useRef(false);
  const [renameDraft, setRenameDraft] = useState('');
  const [creating, setCreating] = useState(false);
  // Effect-driven: Welcome's "New" card increments the tick and we
  // open the form. Skip the initial mount (tick=0 baseline) so this
  // doesn't pop the form open on first render.
  const firstTickRef = useRef(true);
  useEffect(() => {
    if (firstTickRef.current) {
      firstTickRef.current = false;
      return;
    }
    if (openNewSessionTick !== undefined) setCreating(true);
  }, [openNewSessionTick]);
  const rowRefs = useRef<Map<string, HTMLLIElement | null>>(new Map());

  // C-2 hover preview state. Two timers: hoverTimer fires the fetch
  // after 600 ms of dwell; dismissTimer gives the user a 200 ms grace
  // to slide the cursor from row → preview without flicker. We store
  // both as refs since they don't drive render.
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const hoverTimer = useRef<number | null>(null);
  const dismissTimer = useRef<number | null>(null);
  // Generation counter so a fetch that started for row A but resolved
  // after the user moved to row B doesn't overwrite B's preview.
  const previewGen = useRef(0);

  const clearHoverTimer = () => {
    if (hoverTimer.current !== null) {
      window.clearTimeout(hoverTimer.current);
      hoverTimer.current = null;
    }
  };
  const clearDismissTimer = () => {
    if (dismissTimer.current !== null) {
      window.clearTimeout(dismissTimer.current);
      dismissTimer.current = null;
    }
  };
  const closePreview = useCallback(() => {
    clearHoverTimer();
    clearDismissTimer();
    previewGen.current++;
    setPreview(null);
  }, []);

  // Show preview for a session row. Disabled for pending/non-live
  // entries — the server would 204 anyway, but skipping the fetch
  // keeps round-trips off the network.
  const openPreviewFor = useCallback((s: C3Entry, el: HTMLElement) => {
    if (!s.claudeUuid || !s.live) return;
    const rect = el.getBoundingClientRect();
    const cached = getCachedTail(s.id);
    const gen = ++previewGen.current;
    setPreview({ rowId: s.id, rect, text: cached });
    if (cached !== null) return;
    fetchSessionTail(s.id, 2048)
      .then((text) => {
        setCachedTail(s.id, text);
        // Stale fetch: user moved to another row already.
        if (previewGen.current !== gen) return;
        setPreview((p) => (p && p.rowId === s.id ? { ...p, text } : p));
      })
      .catch(() => {
        if (previewGen.current !== gen) return;
        // Render as empty rather than surfacing an error toast for a
        // decorative tooltip.
        setPreview((p) => (p && p.rowId === s.id ? { ...p, text: '' } : p));
      });
  }, []);

  const onRowMouseEnter = useCallback(
    (s: C3Entry, el: HTMLElement) => {
      // Disable preview during rename / for pending rows.
      if (renamingId === s.id || !s.claudeUuid || !s.live) return;
      clearDismissTimer();
      clearHoverTimer();
      hoverTimer.current = window.setTimeout(() => {
        hoverTimer.current = null;
        openPreviewFor(s, el);
      }, HOVER_DELAY_MS);
    },
    [openPreviewFor, renamingId],
  );
  const onRowMouseLeave = useCallback(() => {
    clearHoverTimer();
    clearDismissTimer();
    dismissTimer.current = window.setTimeout(() => {
      dismissTimer.current = null;
      previewGen.current++;
      setPreview(null);
    }, DISMISS_DELAY_MS);
  }, []);
  const onPreviewMouseEnter = useCallback(() => {
    clearDismissTimer();
  }, []);
  // Unmount cleanup.
  useEffect(
    () => () => {
      clearHoverTimer();
      clearDismissTimer();
    },
    [],
  );

  // C-1: activity polling for the sparkline. We keep a per-row map of
  // buckets in state so canvases re-render only when their data
  // changes. The poll loop runs every 2 s, skips when the tab is
  // hidden, and only requests at most ACTIVITY_MAX_ROWS live rows so a
  // very long sidebar doesn't generate dozens of round-trips. Pending
  // and non-live entries are skipped entirely — server would 204 anyway.
  const [activity, setActivity] = useState<Map<string, number[] | null>>(
    () => new Map(),
  );
  useEffect(() => {
    if (!sessions || sessions.length === 0) return;
    let cancelled = false;
    const tick = async () => {
      if (document.hidden) return;
      const live = sessions
        .filter((s) => s.live && !!s.claudeUuid)
        .slice(0, ACTIVITY_MAX_ROWS);
      if (live.length === 0) return;
      const results = await Promise.all(
        live.map(async (s) => {
          const cached = getCachedActivity(s.id);
          if (cached !== undefined) return [s.id, cached] as const;
          try {
            // fetchActivity now returns {buckets, idleMs}; sparkline
            // only needs buckets. The idleMs companion is consumed by
            // TerminalPane via its own poll (independent cadence).
            const r = await fetchActivity(s.id);
            const b = r ? r.buckets : null;
            setCachedActivity(s.id, b);
            return [s.id, b] as const;
          } catch {
            return [s.id, null] as const;
          }
        }),
      );
      if (cancelled) return;
      setActivity((prev) => {
        // Only allocate a new Map if at least one entry actually
        // changed — reduces React rerender churn when the server
        // returns the same buckets two polls in a row.
        let changed = false;
        const next = new Map(prev);
        for (const [id, b] of results) {
          const cur = prev.get(id);
          if (!buckets_eq(cur, b)) {
            next.set(id, b);
            changed = true;
          }
        }
        return changed ? next : prev;
      });
    };
    void tick();
    const interval = window.setInterval(() => void tick(), ACTIVITY_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [sessions]);

  const closeMenuLocal = useCallback(() => {
    const rowId = menu?.rowId;
    setMenu(null);
    if (rowId) {
      // restore focus to row
      window.setTimeout(() => {
        const el = rowRefs.current.get(rowId);
        el?.focus?.();
      }, 0);
    }
  }, [menu]);

  // --- mutation helpers ---------------------------------------------------

  const doArchive = useCallback(
    async (s: C3Entry) => {
      try {
        const r = await archiveSession(s.id);
        showToast(r.archived ? `Archived ${s.name || s.id}` : `Unarchived ${s.name || s.id}`, {
          variant: 'info',
        });
        onAfterMutate();
      } catch (err) {
        const msg = err instanceof ApiError ? err.body : 'Archive failed';
        showToast(msg, { variant: 'error' });
      }
    },
    [onAfterMutate, showToast],
  );

  const doRemove = useCallback(
    async (s: C3Entry) => {
      const wasLive = !!s.live;
      try {
        await removeSession(s.id, wasLive);
        showToast(`Removed ${s.name || s.id}`, { variant: 'info' });
        if (s.claudeUuid) onCloseTabFor(s.claudeUuid);
        onAfterMutate();
      } catch (err) {
        if (err instanceof ApiError && err.status === 409) {
          // Defensive: server returned 409 even though we didn't think
          // entry was live. Retry once with force=1.
          try {
            await removeSession(s.id, true);
            showToast(`Removed ${s.name || s.id} (force)`, { variant: 'warning' });
            if (s.claudeUuid) onCloseTabFor(s.claudeUuid);
            onAfterMutate();
            return;
          } catch (err2) {
            const msg = err2 instanceof ApiError ? err2.body : 'Remove failed';
            showToast(msg, { variant: 'error' });
            return;
          }
        }
        const msg = err instanceof ApiError ? err.body : 'Remove failed';
        showToast(msg, { variant: 'error' });
      }
    },
    [onAfterMutate, onCloseTabFor, showToast],
  );

  const startRename = useCallback((s: C3Entry) => {
    setRenamingId(s.id);
    setRenameDraft(s.name || '');
  }, []);

  const commitRename = useCallback(
    async (s: C3Entry) => {
      const next = renameDraft.trim();
      setRenamingId(null);
      if (renameCancelledRef.current) {
        renameCancelledRef.current = false;
        return;
      }
      if (!next || next === s.name) return;
      try {
        await renameSession(s.id, next);
        showToast(`Renamed to ${next}`, { variant: 'info' });
        onAfterMutate();
      } catch (err) {
        const msg = err instanceof ApiError ? err.body : 'Rename failed';
        showToast(msg, { variant: 'error' });
      }
    },
    [onAfterMutate, renameDraft, showToast],
  );

  // --- menu construction --------------------------------------------------

  const buildMenu = useCallback(
    (s: C3Entry): MenuItem[] => {
      const isOpen = !!s.claudeUuid && openSet.has(s.claudeUuid);
      const pending = !s.claudeUuid;
      const archived = view === 'archived';
      return [
        {
          id: 'open',
          // Pending entries: opening the tab triggers D-7 spawn flow
          // (claude no-resume) so the label reads "Start" to telegraph
          // the side-effect.
          label: pending
            ? 'Start session in tab'
            : isOpen
              ? 'Switch to tab'
              : 'Open in tab',
          onClick: () => {
            onOpen(s);
            onSessionSelected?.();
          },
        },
        {
          id: 'rename',
          label: 'Rename…',
          hint: 'R',
          onClick: () => startRename(s),
        },
        {
          id: 'archive',
          label: archived ? 'Unarchive' : 'Archive',
          hint: 'A',
          onClick: () => void doArchive(s),
        },
        {
          id: 'remove',
          label: s.live ? 'Remove… (PTY live)' : 'Remove…',
          hint: '⌘⌫',
          confirm: true,
          confirmLabel: 'Confirm remove?',
          onClick: () => void doRemove(s),
        },
        { id: 'sep1', label: '', separator: true },
        {
          id: 'copy-uuid',
          label: 'Copy uuid',
          disabled: pending,
          onClick: () => {
            if (s.claudeUuid) void navigator.clipboard?.writeText(s.claudeUuid);
          },
        },
        {
          id: 'copy-cwd',
          label: 'Copy cwd',
          disabled: !s.cwd,
          onClick: () => {
            if (s.cwd) void navigator.clipboard?.writeText(s.cwd);
          },
        },
      ];
    },
    [
      doArchive,
      doRemove,
      onOpen,
      onSessionSelected,
      openSet,
      startRename,
      view,
    ],
  );

  // Segmented Active|Archived arrow nav — migrated to the shortcut
  // registry (PLAN.md P-3). Scope 'sidebar-focused' + the `when`
  // predicate keep these entries inert unless the focused element is
  // inside the segmented tablist itself.
  const segWhen = () => {
    const el = document.activeElement;
    return !!el && !!el.closest('.segmented[role="tablist"]');
  };
  const toggleView = () =>
    onViewChange(view === 'active' ? 'archived' : 'active');
  useShortcut(
    {
      id: 'sidebar.segmented.left',
      keys: 'ArrowLeft',
      scope: 'sidebar-focused',
      label: 'Toggle Active / Archived',
      when: segWhen,
      handler: toggleView,
    },
    [view, onViewChange],
  );
  useShortcut(
    {
      id: 'sidebar.segmented.right',
      keys: 'ArrowRight',
      scope: 'sidebar-focused',
      label: 'Toggle Active / Archived',
      when: segWhen,
      handler: toggleView,
    },
    [view, onViewChange],
  );

  // Row-level keys (r / a / Delete / Backspace). Enter stays local on
  // the row (it's button-activation semantics for role="button").
  // The handler reads the focused row's id from data-row-id and looks
  // up the entry by id — the registry is one set per Sidebar instance,
  // not per row.
  const focusedRowEntry = (): C3Entry | null => {
    const el = document.activeElement;
    if (!el) return null;
    const li = el.closest<HTMLElement>('li.session[data-row-id]');
    const rid = li?.dataset.rowId;
    if (!rid) return null;
    return sessions?.find((s) => s.id === rid) ?? null;
  };
  const rowWhen = () => focusedRowEntry() !== null && !renamingId;
  useShortcut(
    {
      id: 'sidebar.row.rename',
      keys: 'r',
      scope: 'sidebar-focused',
      label: 'Rename focused session',
      when: rowWhen,
      handler: () => {
        const s = focusedRowEntry();
        if (s) startRename(s);
      },
    },
    [sessions, renamingId, startRename],
  );
  useShortcut(
    {
      id: 'sidebar.row.archive',
      keys: 'a',
      scope: 'sidebar-focused',
      label: 'Archive / Unarchive focused session',
      when: rowWhen,
      handler: () => {
        const s = focusedRowEntry();
        if (s) void doArchive(s);
      },
    },
    [sessions, renamingId, doArchive],
  );
  // Delete / Backspace open the row menu in danger-armed state — the
  // user picks Remove and confirms there (avoids a parallel confirm UI).
  const openRowMenuAtRow = (s: C3Entry) => {
    const el = rowRefs.current.get(s.id);
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setMenu({ rowId: s.id, x: rect.right - 200, y: rect.bottom });
  };
  useShortcut(
    {
      id: 'sidebar.row.delete',
      keys: 'Delete',
      scope: 'sidebar-focused',
      label: 'Open row actions (delete focus)',
      when: rowWhen,
      handler: () => {
        const s = focusedRowEntry();
        if (s) openRowMenuAtRow(s);
      },
    },
    [sessions, renamingId],
  );
  useShortcut(
    {
      id: 'sidebar.row.backspace',
      keys: 'Backspace',
      scope: 'sidebar-focused',
      label: 'Open row actions',
      when: rowWhen,
      handler: () => {
        const s = focusedRowEntry();
        if (s) openRowMenuAtRow(s);
      },
    },
    [sessions, renamingId],
  );

  const onMenuClose = useCallback(() => {
    closeMenuLocal();
  }, [closeMenuLocal]);

  const currentMenuItems = menu
    ? (() => {
        const s = sessions?.find((x) => x.id === menu.rowId);
        return s ? buildMenu(s) : [];
      })()
    : [];

  // Filter shortcut (B-2). `/` focuses the input. Guarded so we don't
  // steal the key while xterm or any input has focus — xterm.onData
  // already swallows printables when its viewport is focused, but a
  // body-focus state would otherwise hijack a `/` the user typed into,
  // say, the new-session name field.
  useShortcut(
    {
      id: 'sidebar.filter.focus',
      keys: '/',
      scope: 'global',
      label: 'Filter sessions',
      when: () => {
        const el = document.activeElement as HTMLElement | null;
        if (!el) return true;
        const tag = el.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA') return false;
        if (el.isContentEditable) return false;
        // xterm renders its own focusable textarea inside .xterm — caught
        // by the INPUT/TEXTAREA check above. Belt-and-braces: refuse if
        // the focus is anywhere inside an xterm host.
        if (el.closest('.xterm')) return false;
        return true;
      },
      handler: () => filterInputRef.current?.focus(),
    },
    [],
  );

  // Apply filter to the visible list. Combined "name + cwd" substring,
  // case-insensitive. We keep the original sessions array intact for
  // shortcut lookups (focusedRowEntry, menu rowId resolution) — those
  // shouldn't break just because a row got hidden by filter.
  const q = filter.trim().toLowerCase();
  const visibleSessions = q && sessions
    ? sessions.filter((s) => {
        const hay = ((s.name || '') + ' ' + (s.cwd || '')).toLowerCase();
        return hay.includes(q);
      })
    : sessions;

  // Deep-search trigger. Runs when q has ≥3 chars AND (no name matches
  // OR the user explicitly asked). Debounced 250ms — each keystroke
  // resets the timer. Stale responses are dropped via the token ref.
  const nameMatchCount = visibleSessions?.length ?? 0;
  const shouldDeepSearch =
    q.length >= 3 && sessions !== null && (searchForced || nameMatchCount === 0);
  useEffect(() => {
    // Reset the forced flag when the query shrinks below the threshold
    // — re-typing should not silently re-fire the search.
    if (q.length < 3) {
      if (searchForced) setSearchForced(false);
      if (searchState.kind !== 'idle') setSearchState({ kind: 'idle' });
      return;
    }
    if (!shouldDeepSearch) {
      // We have name matches and user hasn't forced — go back to idle.
      if (searchState.kind !== 'idle') setSearchState({ kind: 'idle' });
      return;
    }
    const token = ++searchTokenRef.current;
    // Cancel any in-flight predecessor.
    if (searchAbortRef.current) searchAbortRef.current.abort();
    const ac = new AbortController();
    searchAbortRef.current = ac;
    const timer = window.setTimeout(() => {
      setSearchState({ kind: 'loading' });
      searchSessions(q, 20, ac.signal)
        .then((res) => {
          if (searchTokenRef.current !== token) return;
          setSearchState({
            kind: 'results',
            matches: res.matches,
            truncated: res.truncated,
            q,
          });
        })
        .catch((err) => {
          if (ac.signal.aborted || searchTokenRef.current !== token) return;
          const msg = err instanceof ApiError ? err.body : 'Search failed';
          setSearchState({ kind: 'error', message: msg });
        });
    }, 250);
    return () => {
      window.clearTimeout(timer);
      ac.abort();
    };
    // searchState intentionally not a dep — would loop the effect on
    // every setState. We only re-run when the inputs change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, shouldDeepSearch]);

  // Lookup map: claudeUuid → C3Entry, used to render a search result row
  // as a clickable session (when bound) or a disabled hint (when not).
  const sessionsByUuid = new Map<string, C3Entry>();
  for (const s of sessions ?? []) {
    if (s.claudeUuid) sessionsByUuid.set(s.claudeUuid, s);
  }
  const openSearchMatch = (m: SearchMatch) => {
    const entry = sessionsByUuid.get(m.claudeUuid);
    if (!entry) return; // unbound: click is disabled below
    onOpen(entry);
    onSessionSelected?.();
  };

  // Inline width override only in wide mode — narrow / drawer keeps the
  // fixed 280px from CSS so the slide-in math doesn't depend on a JS var.
  const asideStyle = resizable ? { width: `${width}px`, flexBasis: `${width}px` } : undefined;

  return (
    <aside
      className="sidebar"
      aria-label="Sessions"
      style={asideStyle}
    >
      {resizable && (
        <div
          ref={resizerRef}
          className="sidebar-resizer"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize sidebar"
          aria-valuenow={width}
          aria-valuemin={SIDEBAR_W_MIN}
          aria-valuemax={SIDEBAR_W_MAX}
          tabIndex={0}
          onMouseDown={onResizerMouseDown}
          onDoubleClick={onResizerDblClick}
          onKeyDown={onResizerKeyDown}
          title="Drag to resize · double-click to reset"
        />
      )}
      <header className="sidebar-header">
        <h1>Sessions</h1>
        <button
          className="icon-btn"
          onClick={onRefresh}
          title="Refresh"
          aria-label="Refresh sessions"
        >
          ↻
        </button>
      </header>

      <div className="sidebar-controls">
        <div
          className="segmented"
          role="tablist"
          aria-label="Session view"
        >
          <button
            type="button"
            role="tab"
            aria-selected={view === 'active'}
            tabIndex={view === 'active' ? 0 : -1}
            className={'segmented-btn' + (view === 'active' ? ' active' : '')}
            onClick={() => onViewChange('active')}
          >
            Active
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={view === 'archived'}
            tabIndex={view === 'archived' ? 0 : -1}
            className={'segmented-btn' + (view === 'archived' ? ' active' : '')}
            onClick={() => onViewChange('archived')}
          >
            Archived
          </button>
        </div>

        <div className="sidebar-filter">
          <span className="sidebar-filter-icon" aria-hidden="true">⌕</span>
          <input
            ref={filterInputRef}
            type="text"
            className="sidebar-filter-input"
            placeholder="filter sessions… (/)"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault();
                if (filter) setFilter('');
                else (e.target as HTMLInputElement).blur();
              }
              // Don't let single-letter row shortcuts (r/a) fire while
              // the user is typing in the filter — registry's `when`
              // already guards on focused-row, but stopPropagation here
              // keeps the keydown contract crystal clear.
              e.stopPropagation();
            }}
            aria-label="Filter sessions"
          />
          {filter && (
            <button
              type="button"
              className="sidebar-filter-clear"
              onClick={() => {
                setFilter('');
                filterInputRef.current?.focus();
              }}
              aria-label="Clear filter"
              tabIndex={-1}
            >
              ×
            </button>
          )}
        </div>

        <button
          type="button"
          className={'new-session-btn' + (creating ? ' active' : '')}
          onClick={() => setCreating((v) => !v)}
          aria-expanded={creating}
        >
          <span>+ New session</span>
          <span className="new-session-chev" aria-hidden="true">
            {creating ? '▴' : '▾'}
          </span>
        </button>

        {creating && !narrow && (
          <NewSessionForm
            drawer={false}
            onCancel={() => setCreating(false)}
            onCreated={(entry) => {
              setCreating(false);
              onAfterMutate();
              // Auto-open the new entry's tab if it already has a uuid;
              // pending entries (uuid empty) will spawn-on-attach.
              onOpen(entry);
            }}
            showToast={showToast}
          />
        )}
      </div>

      {creating && narrow && (
        <NewSessionForm
          drawer={true}
          onCancel={() => setCreating(false)}
          onCreated={(entry) => {
            setCreating(false);
            onAfterMutate();
            onOpen(entry);
          }}
          showToast={showToast}
        />
      )}

      {sessions === null ? (
        <ul className="session-list" aria-busy="true" aria-label="Loading sessions">
          {Array.from({ length: 5 }).map((_, i) => (
            <li key={i} className="session session-skeleton" aria-hidden="true">
              <div className="skeleton-line skeleton-line-name" />
              <div className="skeleton-line skeleton-line-cwd" />
            </li>
          ))}
        </ul>
      ) : visibleSessions && visibleSessions.length === 0 ? (
        <div className="empty-hint">
          {q ? (
            <>No sessions match <code>{filter}</code>.</>
          ) : view === 'archived' ? (
            'No archived sessions.'
          ) : (
            <>
              No sessions yet. Run <code>claude</code> in your terminal, or click{' '}
              <em>+ New session</em>.
            </>
          )}
        </div>
      ) : (
        <ul className="session-list">
          {(visibleSessions ?? []).map((s) => {
            const pending = !s.claudeUuid;
            const isActive = !pending && s.claudeUuid === activeUuid;
            const isOpen = !pending && openSet.has(s.claudeUuid);
            const className =
              'session' +
              (isActive ? ' active' : '') +
              (pending ? ' pending' : '') +
              (isOpen && !isActive ? ' open' : '');
            const cwdLabel = s.cwd || '';
            const isRenaming = renamingId === s.id;
            // C-3: hue derives from cwd so multiple sessions on the same
            // project share an accent, but different projects pop apart.
            // Inline as a CSS custom property — CSS owns the actual usage
            // (border-left strip, hover glow, monogram chip).
            const rowTint = cwdTint(s.cwd || '');
            const rowTintFg = cwdTintFg(s.cwd || '');
            const monogram = cwdMonogram(s.cwd || '');
            const rowStyle = {
              '--row-tint': rowTint,
              '--row-tint-fg': rowTintFg,
            } as React.CSSProperties;

            // Enter (button activation) and the ContextMenu key stay
            // local — they're row semantics, not app-level shortcuts.
            // r / a / Delete / Backspace live in the shortcut registry
            // above (scope 'sidebar-focused').
            const onRowKey = (e: React.KeyboardEvent<HTMLLIElement>) => {
              if (isRenaming) return;
              if (e.key === 'Enter') {
                e.preventDefault();
                // Pending entries open too: server spawns claude no-resume
                // (D-7) and sends {type:'pending'} → {type:'ready'} frames
                // for the banner/disableStdin handling.
                onOpen(s);
                onSessionSelected?.();
              } else if (e.key === 'ContextMenu') {
                e.preventDefault();
                const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                setMenu({ rowId: s.id, x: rect.right - 200, y: rect.bottom });
              }
            };

            return (
              <li
                key={s.id}
                ref={(el) => {
                  rowRefs.current.set(s.id, el);
                }}
                data-row-id={s.id}
                className={className}
                style={rowStyle}
                onClick={() => {
                  if (isRenaming) return;
                  closePreview();
                  onOpen(s);
                  onSessionSelected?.();
                }}
                onKeyDown={onRowKey}
                onMouseEnter={(e) => onRowMouseEnter(s, e.currentTarget)}
                onMouseLeave={onRowMouseLeave}
                onContextMenu={(e) => {
                  e.preventDefault();
                  closePreview();
                  setMenu({ rowId: s.id, x: e.clientX, y: e.clientY });
                }}
                tabIndex={0}
                role="button"
                aria-current={isActive ? 'true' : undefined}
                aria-label={
                  pending
                    ? `${s.name || s.id} (pending session — click to start)`
                    : undefined
                }
                title={cwdLabel}
              >
                <div className="session-name">
                  <span
                    className="session-monogram"
                    aria-hidden="true"
                    title={cwdLabel || undefined}
                  >
                    {monogram}
                  </span>
                  {!pending && s.live && (
                    <Sparkline
                      buckets={activity.get(s.id) ?? null}
                      // On the active row the background is also the
                      // tint, so painting bars in the same hue makes
                      // them disappear. Use the lighter "fg" variant
                      // there for contrast.
                      color={isActive ? rowTintFg : rowTint}
                    />
                  )}
                  {isRenaming ? (
                    <input
                      type="text"
                      autoFocus
                      className="rename-input"
                      value={renameDraft}
                      maxLength={80}
                      onChange={(e) => setRenameDraft(e.target.value)}
                      onBlur={() => void commitRename(s)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          void commitRename(s);
                        } else if (e.key === 'Escape') {
                          e.preventDefault();
                          renameCancelledRef.current = true;
                          setRenamingId(null);
                        }
                        e.stopPropagation();
                      }}
                      onClick={(e) => e.stopPropagation()}
                    />
                  ) : (
                    <>
                      <span className="session-name-text">{s.name || s.id}</span>
                      {pending && <span className="badge">pending</span>}
                      {s.live && !pending && (
                        <span className="badge badge-live" title="PTY live">
                          live
                        </span>
                      )}
                      {isOpen && !pending && (
                        <span className="dot" aria-label="Open in tab" />
                      )}
                    </>
                  )}
                  <button
                    type="button"
                    className="session-menu-btn"
                    aria-label="Row actions"
                    tabIndex={-1}
                    onClick={(e) => {
                      e.stopPropagation();
                      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                      setMenu({ rowId: s.id, x: rect.left, y: rect.bottom });
                    }}
                  >
                    ⋯
                  </button>
                </div>
                <div className="session-cwd">{cwdLabel}</div>
                {!pending && <div className="session-uuid">{s.claudeUuid.slice(0, 8)}</div>}
              </li>
            );
          })}
        </ul>
      )}

      {/* Deep-search results section. Rendered below the regular list
          whether or not name matches are present (when both exist, the
          user explicitly clicked "Search messages…"). */}
      {q.length >= 3 && (
        <div className="sidebar-search">
          {nameMatchCount > 0 && searchState.kind === 'idle' && (
            <button
              type="button"
              className="sidebar-search-trigger"
              onClick={() => setSearchForced(true)}
              title="Full-text search across Claude JSONL files"
            >
              Search messages for <code>{filter}</code>…
            </button>
          )}
          {searchState.kind === 'loading' && (
            <div className="sidebar-search-status">Searching messages…</div>
          )}
          {searchState.kind === 'error' && (
            <div className="sidebar-search-status sidebar-search-error">
              {searchState.message}
            </div>
          )}
          {searchState.kind === 'results' && (
            <>
              <div className="sidebar-search-header">
                Messages ({searchState.matches.length}
                {searchState.truncated ? '+' : ''})
              </div>
              {searchState.matches.length === 0 ? (
                <div className="sidebar-search-status">
                  No messages match <code>{filter}</code>.
                </div>
              ) : (
                <ul className="sidebar-search-list">
                  {searchState.matches.map((m) => {
                    const entry = sessionsByUuid.get(m.claudeUuid);
                    const bound = !!entry;
                    const name = entry?.name || entry?.id || m.claudeUuid.slice(0, 8);
                    return (
                      <li
                        key={m.claudeUuid}
                        className={
                          'sidebar-search-row' + (bound ? '' : ' unbound')
                        }
                        onClick={bound ? () => openSearchMatch(m) : undefined}
                        role={bound ? 'button' : undefined}
                        tabIndex={bound ? 0 : -1}
                        onKeyDown={
                          bound
                            ? (e) => {
                                if (e.key === 'Enter' || e.key === ' ') {
                                  e.preventDefault();
                                  openSearchMatch(m);
                                }
                              }
                            : undefined
                        }
                        title={m.cwd}
                      >
                        <div className="sidebar-search-name">{name}</div>
                        <div className="sidebar-search-cwd">{m.cwd}</div>
                        <div className="sidebar-search-snippet">
                          {m.snippet}
                        </div>
                        {!bound && (
                          <div className="sidebar-search-hint">
                            Click <em>Bind</em> in the sidebar first.
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </>
          )}
        </div>
      )}

      {menu && currentMenuItems.length > 0 && (
        <SessionRowMenu
          id={`menu-${menu.rowId}`}
          x={menu.x}
          y={menu.y}
          items={currentMenuItems}
          onClose={onMenuClose}
        />
      )}

      {preview && !menu && (() => {
        const s = sessions?.find((x) => x.id === preview.rowId);
        if (!s) return null;
        return (
          <SessionPreview
            cwd={s.cwd || ''}
            name={s.name || s.id}
            text={preview.text}
            anchorRect={preview.rect}
            onMouseEnter={onPreviewMouseEnter}
            onMouseLeave={onRowMouseLeave}
          />
        );
      })()}
    </aside>
  );
}
