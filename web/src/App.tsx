import { useCallback, useEffect, useRef, useState } from 'react';
import Sidebar, { type SidebarView } from './components/Sidebar';
import StatusBar from './components/StatusBar';
import TabBar from './components/TabBar';
import TerminalPane from './components/TerminalPane';
import Welcome from './components/Welcome';
import { ToastProvider, useToast } from './components/Toast';
import { listSessions } from './lib/api';
import { useShortcut } from './lib/shortcuts';
import { disposeTerm, getTerm } from './lib/terminals';
import type { C2Entry, Tab, TabStatus } from './types';

const NARROW_BP = 800;
const SIDEBAR_LS_KEY = 'cc-terminal:sidebar-open';

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
  const [sessions, setSessions] = useState<C2Entry[]>([]);
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeUuid, setActiveUuid] = useState<string | null>(null);
  const [view, setView] = useState<SidebarView>('active');
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
      when: () => narrow && sidebarOpen,
      handler: () => {
        setSidebarOpen(false);
        userTouched.current = true;
        writeSidebarPref(false);
      },
    },
    [narrow, sidebarOpen],
  );

  const toggleSidebar = useCallback(() => {
    setSidebarOpen((v) => {
      const next = !v;
      userTouched.current = true;
      writeSidebarPref(next);
      return next;
    });
  }, []);

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
