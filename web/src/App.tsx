import { useCallback, useEffect, useRef, useState } from 'react';
import Sidebar, { type SidebarView } from './components/Sidebar';
import StatusBar from './components/StatusBar';
import TabBar from './components/TabBar';
import TerminalPane from './components/TerminalPane';
import Welcome from './components/Welcome';
import Palette, { type PaletteActions } from './components/Palette';
import Cheatsheet from './components/Cheatsheet';
import { ToastProvider, useToast } from './components/Toast';
import { archiveSession, listSessions } from './lib/api';
import { useShortcut } from './lib/shortcuts';
import { disposeTerm, getTerm } from './lib/terminals';
import type { C2Entry, Tab, TabStatus } from './types';

const NARROW_BP = 800;
const SIDEBAR_LS_KEY = 'cc-terminal:sidebar-open';
const SIDEBAR_WIDTH_LS_KEY = 'cc-terminal:sidebar-width';
const TAB_ORDER_SS_KEY = 'cc-terminal:tab-order';
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
  const [sessions, setSessions] = useState<C2Entry[] | null>(null);
  const [sidebarWidth, setSidebarWidth] = useState<number>(() => readSidebarWidth());
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeUuid, setActiveUuid] = useState<string | null>(null);
  const [view, setView] = useState<SidebarView>('active');
  // Power-tool overlays (PLAN.md P-1, P-2). Mutually exclusive: opening
  // one closes the other so we never stack two centered modals.
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [cheatsheetOpen, setCheatsheetOpen] = useState(false);
  // Increments whenever Welcome asks Sidebar to open the new-session
  // form. Sidebar watches this counter via effect and toggles its own
  // `creating` state. Counter (not bool) so repeated clicks always
  // re-trigger even when Sidebar already had it open then closed.
  const [openNewSessionTick, setOpenNewSessionTick] = useState(0);

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

  // ---- session list polling ------------------------------------------------
  const refresh = useCallback(async () => {
    try {
      const data = await listSessions({
        archived: view === 'archived',
        includeLive: true,
      });
      setSessions(data);
      // Discovery upgrade: if any open tab is keyed by a c2 id (pending)
      // and the server has now linked a uuid, swap the tab's keying so
      // future reattach paths through the canonical uuid. We match by
      // c2Id; this is cheap, runs every 5s, and is idempotent.
      setTabs((prev) =>
        prev.map((t) => {
          if (t.claudeUuid && t.claudeUuid !== t.c2Id) return t;
          const match = data.find((e) => e.id === t.c2Id);
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
  // server keys those PTYs by c2 id under the hood (D-7); on the client
  // we use the c2 id as the tab's dedup key until refresh upgrades it.
  const openTab = useCallback((entry: C2Entry) => {
    const key = entry.claudeUuid || entry.id;
    setTabs((prev) => {
      if (prev.some((t) => t.claudeUuid === key || t.c2Id === entry.id)) return prev;
      const t: Tab = {
        claudeUuid: key,
        c2Id: entry.id,
        name: entry.name || entry.id,
        cwd: entry.cwd || '',
        status: entry.claudeUuid ? 'connecting' : 'pending',
      };
      return [...prev, t];
    });
    setActiveUuid(key);
  }, []);

  const closeTab = useCallback(
    (uuid: string) => {
      disposeTerm(uuid);
      setTabs((prev) => prev.filter((t) => t.claudeUuid !== uuid));
      setActiveUuid((cur) => {
        if (cur !== uuid) return cur;
        const remaining = tabs.filter((t) => t.claudeUuid !== uuid);
        return remaining.length ? remaining[remaining.length - 1].claudeUuid : null;
      });
    },
    [tabs],
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
      writeTabOrder(reordered.map((t) => t.claudeUuid));
      return reordered;
    });
  }, []);

  // Persist tab order whenever it changes, and rehydrate once on first
  // mount. Rehydration only reorders existing tabs (per-window session
  // storage; tabs themselves don't survive a reload — but if a future
  // change does add URL routing, this'll Just Work).
  const orderHydratedRef = useRef(false);
  useEffect(() => {
    if (!orderHydratedRef.current && tabs.length > 0) {
      orderHydratedRef.current = true;
      const saved = readTabOrder();
      if (saved.length > 0) {
        setTabs((prev) => {
          const rank = new Map(saved.map((u, i) => [u, i]));
          const sorted = [...prev].sort((a, b) => {
            const ra = rank.has(a.claudeUuid) ? rank.get(a.claudeUuid)! : 1e9;
            const rb = rank.has(b.claudeUuid) ? rank.get(b.claudeUuid)! : 1e9;
            return ra - rb;
          });
          return sorted;
        });
      }
      return;
    }
    writeTabOrder(tabs.map((t) => t.claudeUuid));
  }, [tabs]);

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
        return { ...t, status };
      }),
    );
  }, []);

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
  // pass; archiveActive looks up the c2 entry from the active tab and
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
    const entry = sessions?.find((s) => s.id === t.c2Id) ?? null;
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
      if (narrow) {
        setSidebarOpen(true);
        userTouched.current = true;
        writeSidebarPref(true);
      }
      setOpenNewSessionTick((n) => n + 1);
    },
    setView,
    closeTab,
    killTab,
    closeAllTabs,
    archiveActive: () => void archiveActive(),
    copyCwd,
    openCheatsheet,
  };

  const appClass =
    'app' +
    (narrow ? ' narrow' : '') +
    (narrow && sidebarOpen ? ' drawer-open' : '') +
    (!sidebarOpen && !narrow ? ' sidebar-hidden' : '');

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
        />
      </div>
      <main className="workspace">
        <TabBar
          tabs={tabs}
          activeUuid={activeUuid}
          onSelect={setActiveUuid}
          onClose={closeTab}
          onKill={killTab}
          onReorder={reorderTabs}
        />
        <div className="pane-host">
          {tabs.length === 0 ? (
            <Welcome
              onNewSession={() => {
                // Surface drawer on narrow viewports so the form has a
                // place to mount (Sidebar's narrow path drops it below
                // the row list as a separate panel).
                if (narrow) {
                  setSidebarOpen(true);
                  userTouched.current = true;
                  writeSidebarPref(true);
                }
                setOpenNewSessionTick((n) => n + 1);
              }}
              onShowCheatsheet={openCheatsheet}
            />
          ) : (
            tabs.map((tab) => (
              <TerminalPane
                key={tab.c2Id}
                tab={tab}
                visible={tab.claudeUuid === activeUuid}
                onStatus={onStatus}
                onKicked={onKicked}
                onExit={onExit}
                onPending={onPending}
                onReady={onReady}
                onClose={closeTab}
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
        onOpenSession={openTab}
        onSwitchTab={setActiveUuid}
        actions={paletteActions}
      />
      <Cheatsheet open={cheatsheetOpen} onClose={() => setCheatsheetOpen(false)} />
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
