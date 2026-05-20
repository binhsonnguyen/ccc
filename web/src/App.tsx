import { useCallback, useEffect, useRef, useState } from 'react';
import Sidebar, { type SidebarView } from './components/Sidebar';
import StatusBar from './components/StatusBar';
import TabBar from './components/TabBar';
import TerminalPane from './components/TerminalPane';
import Welcome from './components/Welcome';
import NewSessionPane from './components/NewSessionPane';
import Palette, { type PaletteActions } from './components/Palette';
import Cheatsheet from './components/Cheatsheet';
import { ToastProvider, useToast } from './components/Toast';
import { archiveSession, listSessions } from './lib/api';
import { useShortcut } from './lib/shortcuts';
import { disposeTerm, getTerm } from './lib/terminals';
import { applyTheme, getCurrentTheme, type ThemeName } from './lib/themes';
import { useZenMode } from './lib/useZenMode';
import { parseTabUrl, writeTabUrl } from './lib/url-state';
import type { C3Entry, Tab, TabStatus } from './types';

const NARROW_BP = 800;
const SIDEBAR_LS_KEY = 'c3:sidebar-open';
const SIDEBAR_WIDTH_LS_KEY = 'c3:sidebar-width';
const TAB_ORDER_SS_KEY = 'c3:tab-order';
const SIDEBAR_WIDTH_DEFAULT = 280;
const SIDEBAR_WIDTH_MIN = 200;
const SIDEBAR_WIDTH_MAX = 480;

function readSidebarWidth(): number {
  try {
    const v = localStorage.getItem(SIDEBAR_WIDTH_LS_KEY);
    if (v) {
      const n = parseInt(v, 10);
      if (Number.isFinite(n) && n >= SIDEBAR_WIDTH_MIN && n <= SIDEBAR_WIDTH_MAX) {
        return n;
      }
    }
  } catch {
    /* ignore */
  }
  return SIDEBAR_WIDTH_DEFAULT;
}

function writeSidebarWidth(n: number) {
  try {
    localStorage.setItem(SIDEBAR_WIDTH_LS_KEY, String(n));
  } catch {
    /* ignore */
  }
}

function readTabOrder(): string[] {
  try {
    const v = sessionStorage.getItem(TAB_ORDER_SS_KEY);
    if (!v) return [];
    const arr = JSON.parse(v);
    if (Array.isArray(arr) && arr.every((s) => typeof s === 'string')) return arr;
  } catch {
    /* ignore */
  }
  return [];
}

function writeTabOrder(uuids: string[]) {
  try {
    sessionStorage.setItem(TAB_ORDER_SS_KEY, JSON.stringify(uuids));
  } catch {
    /* ignore */
  }
}

function readSidebarPref(): boolean | null {
  try {
    const v = localStorage.getItem(SIDEBAR_LS_KEY);
    if (v === '1') return true;
    if (v === '0') return false;
  } catch {
    /* ignore */
  }
  return null;
}

function writeSidebarPref(v: boolean) {
  try {
    localStorage.setItem(SIDEBAR_LS_KEY, v ? '1' : '0');
  } catch {
    /* ignore */
  }
}

function AppInner() {
  // null = initial fetch in flight (Sidebar renders skeleton); [] = empty.
  const [sessions, setSessions] = useState<C3Entry[] | null>(null);
  const [sidebarWidth, setSidebarWidth] = useState<number>(() => readSidebarWidth());
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeUuid, setActiveUuid] = useState<string | null>(null);
  // URL hash is the source of truth for which tabs/active are open across
  // reloads. Parse synchronously on first render so we know what to open
  // as soon as the sessions list arrives (see hydration effect below).
  // localStorage tab order is honored only as a fallback when the hash is
  // empty (legacy users); the next reload writes the URL and that path
  // becomes irrelevant.
  const initialUrlStateRef = useRef(
    typeof window !== 'undefined' ? parseTabUrl(window.location.hash) : { ids: [], active: null },
  );
  const [view, setView] = useState<SidebarView>('active');
  // Power-tool overlays (PLAN.md P-1, P-2). Mutually exclusive: opening
  // one closes the other so we never stack two centered modals.
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [cheatsheetOpen, setCheatsheetOpen] = useState(false);
  // Increments whenever Welcome asks Sidebar to open the new-session
  // form. Sidebar watches this counter via effect and toggles its own
  // `creating` state. Counter (not bool) so repeated clicks always
  // re-trigger even when Sidebar already had it open then closed.
  // openNewSessionTick still drives the legacy Sidebar inline-form
  // path when onRequestCreate isn't wired (defensive — App always
  // passes it now, but the Sidebar prop is optional). The setter is
  // intentionally unused: the inline first-prompt flow supersedes it,
  // but we keep the prop wire so a future hotfix can re-enable the
  // old path without re-threading state.
  const [openNewSessionTick] = useState(0);
  // Inline first-prompt new-session flow. When true, the main pane
  // renders NewSessionPane in place of Welcome/TerminalPane. Cleared
  // on Cancel, on successful submit (we swap to the freshly opened
  // tab), and whenever the user switches to a different tab via the
  // tab bar / palette / keyboard. Always render NewSessionPane EXCLUSIVE
  // of the terminal panes — never stack both.
  const [creatingSession, setCreatingSession] = useState(false);
  const startCreatingSession = useCallback(() => {
    setCreatingSession(true);
    setActiveUuid(null);
  }, []);

  // Theme. initThemeEarly() in main.tsx already set the <html> class
  // and the in-module `current` from localStorage before React mounted,
  // so reading getCurrentTheme() here is consistent with first paint —
  // no flicker. setThemeName re-applies (idempotent) which also walks
  // any live terms; on first render the Map is empty so it's a no-op.
  const [themeName, setThemeName] = useState<ThemeName>(() => getCurrentTheme());
  const onThemeChange = useCallback((next: ThemeName) => {
    applyTheme(next);
    setThemeName(next);
  }, []);

  // Sidebar/drawer state. Default: respect user pref if set, otherwise
  // open on wide viewports, closed on narrow.
  const [narrow, setNarrow] = useState(
    () => typeof window !== 'undefined' && window.innerWidth < NARROW_BP,
  );
  const [sidebarOpen, setSidebarOpen] = useState(() => {
    const pref = readSidebarPref();
    if (pref !== null) return pref;
    return typeof window !== 'undefined' ? window.innerWidth >= NARROW_BP : true;
  });
  // userTouched: once the user manually toggled, we stop auto-syncing on
  // resize so we don't fight their intent.
  const userTouched = useRef(readSidebarPref() !== null);

  const { showToast } = useToast();

  // C-4 zen-mode auto-fade. Hook owns the timer + listeners; we apply
  // its boolean as a class on .app and let CSS handle the transition.
  const zenFaded = useZenMode();

  // C-5: clear mention count on activation, and bump on incoming
  // matches. `activateTab` wraps setActiveUuid so every code path
  // that switches tabs (TabBar click, keyboard nav, palette, etc.)
  // goes through the reset — no need to remember to call both.
  const activateTab = useCallback((uuid: string | null) => {
    setActiveUuid(uuid);
    // Activating any tab (or explicitly clearing) means the user has
    // committed to viewing terminal content — close the new-session
    // pane if it was open. Counter-review #9.
    if (uuid !== null) setCreatingSession(false);
    if (uuid === null) return;
    setTabs((prev) =>
      prev.map((t) =>
        t.claudeUuid === uuid && t.mentions ? { ...t, mentions: 0 } : t,
      ),
    );
  }, []);

  // activeUuid via ref so onMention's identity stays stable across
  // tab switches. If it depended on activeUuid directly, every switch
  // would invalidate openWS in TerminalPane (which closes over
  // onMention) and rebuild the whole effect — closing + reopening the
  // WebSocket and term.reset()-ing every pane on every click.
  const activeUuidRef = useRef(activeUuid);
  useEffect(() => {
    activeUuidRef.current = activeUuid;
  }, [activeUuid]);
  const onMention = useCallback((uuid: string, delta: number) => {
    if (uuid === activeUuidRef.current) return;
    setTabs((prev) =>
      prev.map((t) =>
        t.claudeUuid === uuid
          ? { ...t, mentions: (t.mentions ?? 0) + delta }
          : t,
      ),
    );
  }, []);

  // ---- session list polling ------------------------------------------------
  const refresh = useCallback(async () => {
    try {
      const data = await listSessions({
        archived: view === 'archived',
        includeLive: true,
      });
      setSessions(data);
      // Discovery upgrade: if any open tab is keyed by a c3 id (pending)
      // and the server has now linked a uuid, swap the tab's keying so
      // future reattach paths through the canonical uuid. We match by
      // c3Id; this is cheap, runs every 5s, and is idempotent.
      setTabs((prev) =>
        prev.map((t) => {
          if (t.claudeUuid && t.claudeUuid !== t.c3Id) return t;
          const match = data.find((e) => e.id === t.c3Id);
          if (match && match.claudeUuid && match.claudeUuid !== t.claudeUuid) {
            return { ...t, claudeUuid: match.claudeUuid };
          }
          return t;
        }),
      );
    } catch (err) {
      console.error(err);
      // Flip skeleton off into an empty state so the user sees the
      // sidebar's "no sessions" hint plus the Retry toast, instead of
      // shimmer rows hanging forever when the very first fetch fails.
      setSessions((prev) => prev ?? []);
      showToast('Failed to load sessions', {
        variant: 'error',
        action: { label: 'Retry', onClick: () => void refresh() },
      });
    }
  }, [showToast, view]);

  useEffect(() => {
    refresh();
    const id = window.setInterval(refresh, 5000);
    const onFocus = () => refresh();
    window.addEventListener('focus', onFocus);
    return () => {
      window.clearInterval(id);
      window.removeEventListener('focus', onFocus);
    };
  }, [refresh]);

  // ---- viewport tracking --------------------------------------------------
  useEffect(() => {
    const onResize = () => {
      const nowNarrow = window.innerWidth < NARROW_BP;
      setNarrow((wasNarrow) => {
        if (wasNarrow !== nowNarrow && !userTouched.current) {
          // Only adjust open state on threshold cross if user hasn't taken
          // manual control. Avoids surprise-open when dragging window.
          setSidebarOpen(!nowNarrow);
        }
        return nowNarrow;
      });
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // ---- drawer ESC (only when drawer-style + open) -------------------------
  // Migrated to the shortcut registry (PLAN.md P-3). `when` gates this
  // entry to drawer mode + open state so it doesn't race with the
  // terminal-dead overlay ESC handler in TerminalPane.
  useShortcut(
    {
      id: 'drawer.close',
      keys: 'Escape',
      scope: 'global',
      label: 'Close sidebar drawer',
      // Esc dispatch is fire-all (see lib/shortcuts.ts). When the
      // palette or cheatsheet is open, their own Esc handlers should
      // be the only ones to fire — otherwise Esc closes both the
      // overlay and the drawer underneath, which is jarring.
      when: () => narrow && sidebarOpen && !paletteOpen && !cheatsheetOpen,
      handler: () => {
        setSidebarOpen(false);
        userTouched.current = true;
        writeSidebarPref(false);
      },
    },
    [narrow, sidebarOpen, paletteOpen, cheatsheetOpen],
  );

  const toggleSidebar = useCallback(() => {
    setSidebarOpen((v) => {
      const next = !v;
      userTouched.current = true;
      writeSidebarPref(next);
      return next;
    });
  }, []);

  // ⌘B / Ctrl+B toggles the sidebar (B-3). Works in wide mode (hide /
  // show via .sidebar-hidden) and in drawer mode (open / close drawer).
  //
  // `when` excludes the case where xterm has focus — on Linux/Windows
  // Mod resolves to Ctrl, and Ctrl+B is the tmux prefix + the bash
  // backward-char binding. Stealing it from the terminal would silently
  // break common workflows.
  useShortcut(
    {
      id: 'sidebar.toggle',
      keys: 'Mod+b',
      scope: 'global',
      label: 'Toggle sidebar',
      when: () => {
        const el = document.activeElement as HTMLElement | null;
        return !el?.closest('.xterm');
      },
      handler: () => toggleSidebar(),
    },
    [toggleSidebar],
  );

  // Palette + cheatsheet open shortcuts. Both guard against input focus
  // so typing `?` in the new-session name field or `Mod+k` in the
  // sidebar filter doesn't yank the user into an overlay. xterm renders
  // its own textarea — same guard catches it.
  const notInInput = () => {
    const el = document.activeElement as HTMLElement | null;
    if (!el) return true;
    const tag = el.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return false;
    if (el.isContentEditable) return false;
    if (el.closest('.xterm')) return false;
    return true;
  };
  const openPalette = useCallback(() => {
    setCheatsheetOpen(false);
    setPaletteOpen(true);
  }, []);
  const openCheatsheet = useCallback(() => {
    setPaletteOpen(false);
    setCheatsheetOpen(true);
  }, []);
  useShortcut(
    {
      id: 'palette.open',
      keys: 'Mod+k',
      scope: 'global',
      label: 'Open command palette',
      when: notInInput,
      handler: () => openPalette(),
    },
    [openPalette],
  );
  useShortcut(
    {
      id: 'cheatsheet.open',
      // `?` on US layouts is Shift+/, so the dispatcher's canonical
      // form is "Shift+?", not "?". Register both so the on-screen
      // hint and the actual binding agree.
      keys: 'Shift+?',
      scope: 'global',
      label: 'Show keyboard shortcuts',
      when: notInInput,
      handler: () => openCheatsheet(),
    },
    [openCheatsheet],
  );
  useShortcut(
    {
      id: 'cheatsheet.open.alt',
      keys: 'Mod+/',
      scope: 'global',
      label: 'Show keyboard shortcuts',
      when: notInInput,
      handler: () => openCheatsheet(),
    },
    [openCheatsheet],
  );

  const closeDrawer = useCallback(() => {
    if (!narrow) return;
    setSidebarOpen(false);
    userTouched.current = true;
    writeSidebarPref(false);
  }, [narrow]);

  // ---- tab management ------------------------------------------------------
  // We allow opening tabs for pending entries (claudeUuid empty). The
  // server keys those PTYs by c3 id under the hood (D-7); on the client
  // we use the c3 id as the tab's dedup key until refresh upgrades it.
  const openTab = useCallback((entry: C3Entry) => {
    const key = entry.claudeUuid || entry.id;
    setTabs((prev) => {
      if (prev.some((t) => t.claudeUuid === key || t.c3Id === entry.id)) return prev;
      const t: Tab = {
        claudeUuid: key,
        c3Id: entry.id,
        name: entry.name || entry.id,
        cwd: entry.cwd || '',
        status: entry.claudeUuid ? 'connecting' : 'pending',
      };
      return [...prev, t];
    });
    activateTab(key);
  }, [activateTab]);

  const closeTab = useCallback(
    (uuid: string) => {
      disposeTerm(uuid);
      setTabs((prev) => prev.filter((t) => t.claudeUuid !== uuid));
      if (activeUuidRef.current === uuid) {
        const remaining = tabs.filter((t) => t.claudeUuid !== uuid);
        // Route through activateTab so the promoted tab also gets its
        // mention badge cleared — same contract as TabBar/Palette/etc.
        activateTab(remaining.length ? remaining[remaining.length - 1].claudeUuid : null);
      }
    },
    [tabs, activateTab],
  );

  // Reorder lifted from TabBar (B-4). New uuid list = the dragged tab
   // inserted at a new index. We map back into the Tab[] array — uuids
   // not present in `next` (stale) are dropped, uuids present but not in
   // current tabs (shouldn't happen) are ignored.
  const reorderTabs = useCallback((nextUuids: string[]) => {
    setTabs((prev) => {
      const byUuid = new Map(prev.map((t) => [t.claudeUuid, t]));
      const reordered: Tab[] = [];
      for (const u of nextUuids) {
        const t = byUuid.get(u);
        if (t) {
          reordered.push(t);
          byUuid.delete(u);
        }
      }
      // Append any tabs that weren't in nextUuids (defensive — keeps
      // them from vanishing if caller passed an incomplete list).
      for (const t of byUuid.values()) reordered.push(t);
      return reordered;
    });
  }, []);

  // ---- URL-routed tab hydration -------------------------------------------
  // On first sessions-list load, open tabs for any c3Ids present in the
  // URL hash (or the legacy localStorage fallback when the hash is empty).
  // Unknown c3Ids are silently dropped. Runs at most once per mount.
  const hydratedRef = useRef(false);
  useEffect(() => {
    if (hydratedRef.current) return;
    if (sessions === null) return; // wait for first fetch to settle
    hydratedRef.current = true;

    let ids = initialUrlStateRef.current.ids;
    let active = initialUrlStateRef.current.active;
    if (ids.length === 0) {
      // Legacy fallback: previous versions stored tab order under
      // claudeUuid in sessionStorage. Honor it ONCE, then the URL sync
      // effect below writes the hash and future reloads use the URL.
      const legacy = readTabOrder();
      if (legacy.length > 0) {
        // Map legacy uuid list → c3Ids via the sessions list.
        const byUuid = new Map(sessions.map((s) => [s.claudeUuid, s.id]));
        ids = legacy.map((u) => byUuid.get(u)).filter((x): x is string => !!x);
      }
    }
    if (ids.length === 0) return;

    const byC3 = new Map(sessions.map((s) => [s.id, s]));
    const toOpen: Tab[] = [];
    for (const id of ids) {
      const entry = byC3.get(id);
      if (!entry) continue; // silently skip unknown
      const key = entry.claudeUuid || entry.id;
      toOpen.push({
        claudeUuid: key,
        c3Id: entry.id,
        name: entry.name || entry.id,
        cwd: entry.cwd || '',
        status: entry.claudeUuid ? 'connecting' : 'pending',
      });
    }
    if (toOpen.length === 0) return;
    setTabs(toOpen);
    const activeEntry = active ? byC3.get(active) : null;
    const activeKey = activeEntry
      ? activeEntry.claudeUuid || activeEntry.id
      : toOpen[0].claudeUuid;
    setActiveUuid(activeKey);
  }, [sessions]);

  // Mirror tabs/active into the URL hash on every change. replaceState
  // means the back button doesn't step through tab edits; it also doesn't
  // fire popstate, so this can't loop with the parser. Wait until after
  // hydration so we don't blow away the incoming hash before we've read
  // it (the parser runs synchronously, but sessions=null delays
  // hydration; writing the URL early would still serialize empty tabs).
  useEffect(() => {
    if (!hydratedRef.current) return;
    const activeTab = tabs.find((t) => t.claudeUuid === activeUuid);
    writeTabUrl({
      ids: tabs.map((t) => t.c3Id),
      active: activeTab ? activeTab.c3Id : null,
    });
    // Keep the legacy localStorage in sync for one more cycle so a
    // downgrade to an older bundle still finds something.
    writeTabOrder(tabs.map((t) => t.claudeUuid));
  }, [tabs, activeUuid]);

  const killTab = useCallback(
    (uuid: string) => {
      const entry = getTerm(uuid);
      const ws = entry?.ws;
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        showToast(
          'WS disconnected; cannot kill PTY remotely. Use `pkill claude` to terminate.',
          { variant: 'warning' },
        );
        return;
      }
      ws.send(JSON.stringify({ type: 'kill' }));
      setTabs((prev) =>
        prev.map((t) => (t.claudeUuid === uuid ? { ...t, killing: true } : t)),
      );
      window.setTimeout(() => {
        setTabs((prev) =>
          prev.map((t) =>
            t.claudeUuid === uuid && t.killing && t.status !== 'exited'
              ? { ...t, killing: false }
              : t,
          ),
        );
      }, 3000);
    },
    [showToast],
  );

  const updateTabStatus = useCallback((uuid: string, patch: Partial<Tab>) => {
    setTabs((prev) =>
      prev.map((t) => (t.claudeUuid === uuid ? { ...t, ...patch } : t)),
    );
  }, []);

  const onKicked = useCallback(
    (uuid: string) => {
      updateTabStatus(uuid, { status: 'kicked' });
      showToast('Session attached elsewhere — this tab was disconnected.', {
        variant: 'warning',
      });
    },
    [showToast, updateTabStatus],
  );

  const onExit = useCallback(
    (uuid: string, code: number) => {
      // Reset `killing` here too: when the user clicked Kill we set the
      // flag so the button shows "killing…", but the 3 s safety timer
      // only unsticks it if status hasn't moved to 'exited'. If the PTY
      // dies fast (which is the *expected* path after a Kill), the timer
      // bails out and the button would stay disabled until the tab is
      // manually closed.
      updateTabStatus(uuid, { status: 'exited', exitCode: code, killing: false });
      showToast(`claude exited (code ${code}).`, { variant: 'info' });
    },
    [showToast, updateTabStatus],
  );

  const onStatus = useCallback((uuid: string, status: TabStatus) => {
    setTabs((prev) =>
      prev.map((t) => {
        if (t.claudeUuid !== uuid) return t;
        if (t.status === 'kicked' || t.status === 'exited') return t;
        // Don't downgrade pending → connected via ws.onopen; we only flip
        // out of 'pending' when the server explicitly sends {type:'ready'}.
        if (t.status === 'pending' && status === 'connected') return t;
        // Don't let ws.onclose's generic 'disconnected' overwrite a
        // specific 'error' that the server's last control frame set.
        // Reconnect (which fires 'connecting' below) clears the error.
        if (t.status === 'error' && status === 'disconnected') return t;
        if (status === 'connecting' || status === 'connected') {
          return { ...t, status, errorMessage: undefined };
        }
        return { ...t, status };
      }),
    );
  }, []);

  // Server sent {type:"error",message} during attach (e.g. claude not
  // in PATH). Persist the message so the transport-problem banner can
  // show the real reason instead of a generic "Disconnected".
  const onError = useCallback((uuid: string, message: string) => {
    setTabs((prev) =>
      prev.map((t) =>
        t.claudeUuid === uuid ? { ...t, status: 'error', errorMessage: message } : t,
      ),
    );
    showToast(`Attach failed: ${message}`, { variant: 'error' });
  }, [showToast]);

  const onReady = useCallback(
    (uuid: string) => {
      setTabs((prev) =>
        prev.map((t) => (t.claudeUuid === uuid ? { ...t, status: 'connected' } : t)),
      );
      showToast('Session ready.', { variant: 'success' });
      // Pull the new uuid into the list / tab keying.
      void refresh();
    },
    [refresh, showToast],
  );

  const onPending = useCallback((uuid: string) => {
    setTabs((prev) =>
      prev.map((t) => (t.claudeUuid === uuid ? { ...t, status: 'pending' } : t)),
    );
  }, []);

  // Palette helpers. closeAllTabs disposes terms + clears state in one
  // pass; archiveActive looks up the c3 entry from the active tab and
  // mutates via the API directly (cheaper than threading the Sidebar's
  // doArchive callback through props). copyCwd reuses the same fallback
  // pattern as StatusBar's copy hint.
  const closeAllTabs = useCallback(() => {
    for (const t of tabs) disposeTerm(t.claudeUuid);
    setTabs([]);
    setActiveUuid(null);
  }, [tabs]);
  const archiveActive = useCallback(async () => {
    const t = tabs.find((x) => x.claudeUuid === activeUuid);
    if (!t) return;
    const entry = sessions?.find((s) => s.id === t.c3Id) ?? null;
    if (!entry) return;
    try {
      const r = await archiveSession(entry.id);
      showToast(
        r.archived ? `Archived ${entry.name || entry.id}` : `Unarchived ${entry.name || entry.id}`,
        { variant: 'info' },
      );
      void refresh();
    } catch {
      showToast('Archive failed', { variant: 'error' });
    }
  }, [activeUuid, refresh, sessions, showToast, tabs]);
  const copyCwd = useCallback(
    (cwd: string) => {
      if (!cwd) return;
      if (!navigator.clipboard) {
        showToast('Copy failed — clipboard unavailable', { variant: 'error' });
        return;
      }
      navigator.clipboard
        .writeText(cwd)
        .then(() => showToast('Copied cwd', { variant: 'info' }))
        .catch(() => showToast('Copy failed', { variant: 'error' }));
    },
    [showToast],
  );

  const paletteActions: PaletteActions = {
    refresh: () => void refresh(),
    toggleSidebar,
    openNewSession: () => {
      // Inline first-prompt flow (2026-05-19): always route through
      // the main-pane NewSessionPane. The sidebar's inline form is
      // kept for the Bind dialog only; new-session creation lives
      // here so the user can pre-fill a first prompt + auto-submit.
      startCreatingSession();
    },
    setView,
    closeTab,
    killTab,
    closeAllTabs,
    archiveActive: () => void archiveActive(),
    copyCwd,
    openCheatsheet,
    setTheme: onThemeChange,
  };

  const appClass =
    'app' +
    (narrow ? ' narrow' : '') +
    (narrow && sidebarOpen ? ' drawer-open' : '') +
    (!sidebarOpen && !narrow ? ' sidebar-hidden' : '') +
    (zenFaded ? ' zen-faded' : '');

  return (
    <div className={appClass}>
      {narrow && (
        <button
          className="hamburger"
          onClick={toggleSidebar}
          aria-label={sidebarOpen ? 'Close sessions panel' : 'Open sessions panel'}
          aria-expanded={sidebarOpen}
          aria-controls="primary-sidebar"
        >
          ☰
        </button>
      )}
      {narrow && sidebarOpen && (
        <div
          className="drawer-backdrop"
          onClick={closeDrawer}
          aria-hidden="true"
        />
      )}
      <div className="sidebar-wrap" id="primary-sidebar">
        <Sidebar
          width={sidebarWidth}
          onWidthChange={(w) => {
            setSidebarWidth(w);
            writeSidebarWidth(w);
          }}
          resizable={!narrow}
          sessions={sessions}
          activeUuid={activeUuid}
          openTabs={tabs}
          view={view}
          onViewChange={setView}
          onOpen={openTab}
          onRefresh={refresh}
          onSessionSelected={narrow ? closeDrawer : undefined}
          onAfterMutate={refresh}
          onCloseTabFor={closeTab}
          narrow={narrow}
          showToast={showToast}
          openNewSessionTick={openNewSessionTick}
          onRequestCreate={() => {
            // Mirror Welcome's path: surface the drawer on narrow
            // viewports so the user sees the result, then swap to
            // the main-pane NewSessionPane.
            if (narrow) {
              setSidebarOpen(false); // close drawer so main pane is visible
              userTouched.current = true;
              writeSidebarPref(false);
            }
            startCreatingSession();
          }}
        />
      </div>
      <main className="workspace">
        <TabBar
          tabs={tabs}
          activeUuid={activeUuid}
          onSelect={activateTab}
          onClose={closeTab}
          onKill={killTab}
          onReorder={reorderTabs}
        />
        <div className="pane-host">
          {creatingSession ? (
            // NewSessionPane replaces both Welcome and the terminal
            // panes while active — never stack a form on top of a
            // running terminal. We still mount existing TerminalPane
            // instances hidden underneath so their WS stays attached
            // (closing the form on success → activateTab swaps them
            // back into view without dropping any output).
            <>
              <NewSessionPane
                onCreated={(entry) => {
                  openTab(entry);
                  setCreatingSession(false);
                }}
                onCancel={() => setCreatingSession(false)}
                showToast={showToast}
              />
              {tabs.map((tab) => (
                <TerminalPane
                  key={tab.c3Id}
                  tab={tab}
                  visible={false}
                  onStatus={onStatus}
                  onKicked={onKicked}
                  onExit={onExit}
                  onPending={onPending}
                  onReady={onReady}
                  onError={onError}
                  onClose={closeTab}
                  onMention={onMention}
                />
              ))}
            </>
          ) : tabs.length === 0 ? (
            <Welcome
              onNewSession={startCreatingSession}
              onShowCheatsheet={openCheatsheet}
            />
          ) : (
            tabs.map((tab) => (
              <TerminalPane
                key={tab.c3Id}
                tab={tab}
                visible={tab.claudeUuid === activeUuid}
                onStatus={onStatus}
                onKicked={onKicked}
                onExit={onExit}
                onPending={onPending}
                onReady={onReady}
                onError={onError}
                onClose={closeTab}
                onMention={onMention}
              />
            ))
          )}
        </div>
        {(() => {
          const active = tabs.find((t) => t.claudeUuid === activeUuid) ?? null;
          // Hash status string into a number — StatusBar only uses pulse
          // as a "did this change?" signal to reset its idle timer.
          let pulse = 0;
          if (active) {
            for (let i = 0; i < active.status.length; i++) {
              pulse = (pulse * 31 + active.status.charCodeAt(i)) | 0;
            }
          }
          return (
            <StatusBar
              activeTab={active}
              pulse={pulse}
              themeName={themeName}
              onThemeChange={onThemeChange}
              onCopyCwd={(cwd) => {
                if (!cwd) return;
                // Clipboard requires a secure context. Loopback HTTP
                // counts as secure on Chromium but not always on Safari
                // / older browsers — fall back to an error toast so we
                // don't claim "Copied" when nothing happened.
                if (!navigator.clipboard) {
                  showToast('Copy failed — clipboard unavailable', {
                    variant: 'error',
                  });
                  return;
                }
                navigator.clipboard
                  .writeText(cwd)
                  .then(() => showToast('Copied cwd', { variant: 'info' }))
                  .catch(() =>
                    showToast('Copy failed — permission denied', {
                      variant: 'error',
                    }),
                  );
              }}
            />
          );
        })()}
      </main>
      <Palette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        sessions={sessions}
        tabs={tabs}
        activeUuid={activeUuid}
        view={view}
        themeName={themeName}
        onOpenSession={openTab}
        onSwitchTab={activateTab}
        actions={paletteActions}
      />
      <Cheatsheet
        open={cheatsheetOpen}
        onClose={() => setCheatsheetOpen(false)}
        themeName={themeName}
        onThemeChange={onThemeChange}
      />
    </div>
  );
}

export default function App() {
  return (
    <ToastProvider>
      <AppInner />
    </ToastProvider>
  );
}
