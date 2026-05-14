import { useCallback, useEffect, useRef, useState } from 'react';
import Sidebar from './components/Sidebar';
import TabBar from './components/TabBar';
import TerminalPane from './components/TerminalPane';
import Welcome from './components/Welcome';
import Toast from './components/Toast';
import { listSessions } from './lib/api';
import { disposeTerm } from './lib/terminals';
import type { C2Entry, Tab, TabStatus } from './types';

// App owns three pieces of state:
//   - sessions list (refreshed on focus + every 5s while window is open)
//   - tabs (one entry per open uuid; xterm instance is NOT here)
//   - activeUuid (which tab's pane is visible)
//
// Tabs are addressed by claudeUuid. We deliberately do not key by C2Entry.id
// because the WS endpoint uses claudeUuid, and pending entries (uuid="")
// aren't attachable.
export default function App() {
  const [sessions, setSessions] = useState<C2Entry[]>([]);
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeUuid, setActiveUuid] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<number | null>(null);

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 3500);
  }, []);

  // ---- session list polling ------------------------------------------------
  const refresh = useCallback(async () => {
    try {
      const data = await listSessions();
      setSessions(data);
    } catch (err) {
      console.error(err);
      showToast('Failed to load sessions');
    }
  }, [showToast]);

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

  // ---- tab management ------------------------------------------------------
  const openTab = useCallback((entry: C2Entry) => {
    if (!entry.claudeUuid) {
      // Pending entries can't attach yet.
      return;
    }
    setTabs((prev) => {
      if (prev.some((t) => t.claudeUuid === entry.claudeUuid)) return prev;
      const t: Tab = {
        claudeUuid: entry.claudeUuid,
        name: entry.name || entry.id,
        cwd: entry.cwd || '',
        status: 'connecting',
      };
      return [...prev, t];
    });
    setActiveUuid(entry.claudeUuid);
  }, []);

  const closeTab = useCallback(
    (uuid: string) => {
      // Closing a tab tears down the WS (server detaches; PTY survives).
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

  const updateTabStatus = useCallback(
    (uuid: string, patch: Partial<Tab>) => {
      setTabs((prev) =>
        prev.map((t) => (t.claudeUuid === uuid ? { ...t, ...patch } : t)),
      );
    },
    [],
  );

  const onKicked = useCallback(
    (uuid: string) => {
      updateTabStatus(uuid, { status: 'kicked' });
      showToast('Session attached elsewhere — this tab was disconnected.');
    },
    [showToast, updateTabStatus],
  );

  const onExit = useCallback(
    (uuid: string, code: number) => {
      updateTabStatus(uuid, { status: 'exited', exitCode: code });
      showToast(`claude exited (code ${code}).`);
    },
    [showToast, updateTabStatus],
  );

  const onStatus = useCallback((uuid: string, status: TabStatus) => {
    // Terminal statuses (kicked / exited) outrank transport states. A
    // ws.onclose that fires *after* the server already sent {kicked} or
    // {exit, code} must not erase that information from the UI.
    setTabs((prev) =>
      prev.map((t) => {
        if (t.claudeUuid !== uuid) return t;
        if (t.status === 'kicked' || t.status === 'exited') return t;
        return { ...t, status };
      }),
    );
  }, []);

  return (
    <div className="app">
      <Sidebar
        sessions={sessions}
        activeUuid={activeUuid}
        openTabs={tabs}
        onOpen={openTab}
        onRefresh={refresh}
      />
      <main className="workspace">
        <TabBar
          tabs={tabs}
          activeUuid={activeUuid}
          onSelect={setActiveUuid}
          onClose={closeTab}
        />
        <div className="pane-host">
          {tabs.length === 0 ? (
            <Welcome />
          ) : (
            tabs.map((tab) => (
              <TerminalPane
                key={tab.claudeUuid}
                tab={tab}
                visible={tab.claudeUuid === activeUuid}
                onStatus={onStatus}
                onKicked={onKicked}
                onExit={onExit}
                onClose={closeTab}
              />
            ))
          )}
        </div>
      </main>
      <Toast message={toast} />
    </div>
  );
}
