import { useCallback, useEffect, useRef, useState } from 'react';
import Sidebar, { type SidebarView } from './components/Sidebar';
import StatusBar from './components/StatusBar';
import TabBar from './components/TabBar';
import SplitContainer from './components/SplitContainer';
import Welcome from './components/Welcome';
import NewSessionPane from './components/NewSessionPane';
import Palette, { type PaletteActions } from './components/Palette';
import Cheatsheet from './components/Cheatsheet';
import PtyDimsDialog from './components/PtyDimsDialog';
import { ToastProvider, useToast } from './components/Toast';
import {
  readColCap,
  readRowCap,
  writeColCap,
  writeRowCap,
} from './lib/caps';
import { archiveSession, createSession, listSessions } from './lib/api';
import { useShortcut } from './lib/shortcuts';
import { disposeTerm, getTerm } from './lib/terminals';
import { applyTheme, getCurrentTheme, type ThemeName } from './lib/themes';
import { useZenMode } from './lib/useZenMode';
import { parseTabUrl, writeTabUrl } from './lib/url-state';
import {
  loadLayout,
  paneFromEntry,
  rehydrateTabs,
  useLayoutSync,
} from './lib/layout';
import {
  findPane,
  focusedPane,
  newTabId,
  primaryPane,
  type C3Entry,
  type Pane,
  type Tab,
  type TabStatus,
} from './types';

const NARROW_BP = 800;
const SIDEBAR_LS_KEY = 'c3:sidebar-open';
const SIDEBAR_WIDTH_LS_KEY = 'c3:sidebar-width';
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

// Map a pane mutation across the tabs tree. Helper so the dozen
// onStatus/onMention/onExit/etc handlers stay tiny — they all walk the
// flat panes-of-tabs structure to find their target.
function patchPaneByC3(tabs: Tab[], c3Id: string, patch: Partial<Pane>): Tab[] {
  let changed = false;
  const next = tabs.map((t) => {
    const p0 = t.panes[0];
    const p1: Pane | null = t.panes.length === 2 ? t.panes[1]! : null;
    if (p0.c3Id === c3Id) {
      changed = true;
      const updated: Pane = { ...p0, ...patch };
      return p1
        ? { ...t, panes: [updated, p1] as [Pane, Pane] }
        : { ...t, panes: [updated] as [Pane] };
    }
    if (p1 && p1.c3Id === c3Id) {
      changed = true;
      const updated: Pane = { ...p1, ...patch };
      return { ...t, panes: [p0, updated] as [Pane, Pane] };
    }
    return t;
  });
  return changed ? next : tabs;
}

// Like patchPaneByC3 but matches on claudeUuid (used by ws onmessage
// handlers which only know the claude uuid). Patches ALL matching
// panes — claudeUuid is normally unique but during a discovery
// rekey window two panes can briefly share a value.
function patchPanesByUuid(tabs: Tab[], uuid: string, patch: (p: Pane) => Pane): Tab[] {
  let changed = false;
  const next = tabs.map((t) => {
    const p0 = t.panes[0];
    const p1 = t.panes.length === 2 ? t.panes[1]! : null;
    const np0 = p0.claudeUuid === uuid ? patch(p0) : p0;
    const np1 = p1 && p1.claudeUuid === uuid ? patch(p1) : p1;
    if (np0 === p0 && np1 === p1) return t;
    changed = true;
    return np1
      ? { ...t, panes: [np0, np1] as [Pane, Pane] }
      : { ...t, panes: [np0] as [Pane] };
  });
  return changed ? next : tabs;
}

function AppInner() {
  const [sessions, setSessions] = useState<C3Entry[] | null>(null);
  const [sidebarWidth, setSidebarWidth] = useState<number>(() => readSidebarWidth());
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);

  const initialUrlStateRef = useRef(
    typeof window !== 'undefined' ? parseTabUrl(window.location.hash) : { ids: [], active: null },
  );
  const [view, setView] = useState<SidebarView>('active');
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [cheatsheetOpen, setCheatsheetOpen] = useState(false);
  const [openNewSessionTick] = useState(0);
  const [creatingSession, setCreatingSession] = useState(false);
  const [paneFlashKey, setPaneFlashKey] = useState(0);
  const startCreatingSession = useCallback(() => {
    setCreatingSession((wasOpen) => {
      if (wasOpen) {
        setPaneFlashKey((k) => k + 1);
        return true;
      }
      return true;
    });
    setActiveTabId(null);
  }, []);

  const [themeName, setThemeName] = useState<ThemeName>(() => getCurrentTheme());
  const onThemeChange = useCallback((next: ThemeName) => {
    applyTheme(next);
    setThemeName(next);
  }, []);

  const [colCap, setColCap] = useState<number | null>(() => readColCap());
  const [rowCap, setRowCap] = useState<number | null>(() => readRowCap());
  const [dimsDialogOpen, setDimsDialogOpen] = useState(false);
  const applyDims = useCallback((c: number | null, r: number | null) => {
    setColCap(c); writeColCap(c);
    setRowCap(r); writeRowCap(r);
  }, []);

  const [narrow, setNarrow] = useState(
    () => typeof window !== 'undefined' && window.innerWidth < NARROW_BP,
  );
  const [sidebarOpen, setSidebarOpen] = useState(() => {
    const pref = readSidebarPref();
    if (pref !== null) return pref;
    return typeof window !== 'undefined' ? window.innerWidth >= NARROW_BP : true;
  });
  const userTouched = useRef(readSidebarPref() !== null);

  const { showToast } = useToast();

  const zenFaded = useZenMode();

  // activateTab clears the focused pane's mention badge.
  const activateTab = useCallback((tabId: string | null) => {
    setActiveTabId(tabId);
    if (tabId !== null) setCreatingSession(false);
    if (tabId === null) return;
    setTabs((prev) =>
      prev.map((t) => {
        if (t.id !== tabId) return t;
        const idx = t.focusedPaneIdx;
        const cur = t.panes[idx]!;
        if (!cur.mentions) return t;
        const cleared: Pane = { ...cur, mentions: 0 };
        return idx === 0
          ? (t.panes.length === 2
              ? { ...t, panes: [cleared, t.panes[1]!] as [Pane, Pane] }
              : { ...t, panes: [cleared] as [Pane] })
          : { ...t, panes: [t.panes[0], cleared] as [Pane, Pane] };
      }),
    );
  }, []);

  // Focus a specific pane (by c3Id) within whatever tab owns it.
  // Activates the tab as a side-effect so click-to-focus on a hidden
  // pane (e.g. via overflow menu) does the expected thing.
  const focusPane = useCallback((c3Id: string) => {
    setTabs((prev) => {
      const hit = findPane(prev, c3Id);
      if (!hit) return prev;
      const { tab, idx } = hit;
      // Activate the owning tab as a side-effect — queueMicrotask so we
      // don't nest setState calls inside this updater.
      if (activeTabIdRef.current !== tab.id) {
        queueMicrotask(() => setActiveTabId(tab.id));
      }
      const pane = tab.panes[idx]!;
      const focusChanged = tab.focusedPaneIdx !== idx;
      const cleared: Pane = pane.mentions ? { ...pane, mentions: 0 } : pane;
      if (!focusChanged && cleared === pane) return prev;
      return prev.map((t) => {
        if (t.id !== tab.id) return t;
        const newFocus = (focusChanged ? idx : t.focusedPaneIdx) as 0 | 1;
        if (idx === 0) {
          return t.panes.length === 2
            ? { ...t, focusedPaneIdx: newFocus, panes: [cleared, t.panes[1]!] as [Pane, Pane] }
            : { ...t, focusedPaneIdx: 0, panes: [cleared] as [Pane] };
        }
        return { ...t, focusedPaneIdx: newFocus, panes: [t.panes[0], cleared] as [Pane, Pane] };
      });
    });
  }, []);

  // Track active tab id via ref for the WS onmessage handler.
  const activeTabIdRef = useRef(activeTabId);
  useEffect(() => {
    activeTabIdRef.current = activeTabId;
  }, [activeTabId]);

  const onMention = useCallback((uuid: string, delta: number) => {
    // Skip the bump entirely if the matching pane is currently the
    // focused pane in the active tab — the user is already watching it.
    setTabs((prev) =>
      patchPanesByUuid(prev, uuid, (p) => {
        const hit = findPane(prev, p.c3Id);
        if (hit && hit.tab.id === activeTabIdRef.current && hit.tab.focusedPaneIdx === hit.idx) {
          return p;
        }
        return { ...p, mentions: (p.mentions ?? 0) + delta };
      }),
    );
  }, []);

  // ---- session list polling + discovery rekey -----------------------------
  const refresh = useCallback(async () => {
    try {
      const data = await listSessions({
        archived: view === 'archived',
        includeLive: true,
      });
      setSessions(data);
      // Discovery rekey: if any pane is keyed by a c3 id (pending) and
      // the server has now linked a uuid, swap the pane's claudeUuid so
      // future reattach paths through the canonical uuid. Walks all
      // panes (primary + secondary).
      setTabs((prev) =>
        prev.map((t) => {
          const p0 = t.panes[0];
          const p1 = t.panes.length === 2 ? t.panes[1]! : null;
          const patch = (p: Pane): Pane => {
            if (p.claudeUuid && p.claudeUuid !== p.c3Id) return p;
            const match = data.find((e) => e.id === p.c3Id);
            if (match && match.claudeUuid && match.claudeUuid !== p.claudeUuid) {
              return { ...p, claudeUuid: match.claudeUuid };
            }
            return p;
          };
          const np0 = patch(p0);
          const np1 = p1 ? patch(p1) : null;
          if (np0 === p0 && np1 === p1) return t;
          return np1
            ? { ...t, panes: [np0, np1] as [Pane, Pane] }
            : { ...t, panes: [np0] as [Pane] };
        }),
      );
    } catch (err) {
      console.error(err);
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
          setSidebarOpen(!nowNarrow);
        }
        return nowNarrow;
      });
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  useShortcut(
    {
      id: 'drawer.close',
      keys: 'Escape',
      scope: 'global',
      label: 'Close sidebar drawer',
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

  // ---- tab / pane management ----------------------------------------------
  // openTab is the single-attach bottleneck. If the entry's c3Id is
  // already in any open pane we switch-to instead of duplicating. The
  // Sidebar's row dim is belt-and-suspenders.
  const openTab = useCallback((entry: C3Entry) => {
    setTabs((prev) => {
      const hit = findPane(prev, entry.id);
      if (hit) {
        // Activate the tab + focus the pane that owns this c3Id.
        const nextTabs = prev.map((t) =>
          t.id === hit.tab.id ? { ...t, focusedPaneIdx: hit.idx } : t,
        );
        // Defer active-id mutation outside this setter to avoid double
        // batching collisions; queueMicrotask so the new tabs[] is
        // committed first.
        queueMicrotask(() => {
          setActiveTabId(hit.tab.id);
          const tabIdx = prev.findIndex((t) => t.id === hit.tab.id);
          showToast(`Already open in tab ${tabIdx + 1}`, { variant: 'info' });
        });
        return nextTabs;
      }
      const newPane = paneFromEntry(entry);
      const newTab: Tab = {
        id: newTabId(),
        panes: [newPane],
        orientation: 'h',
        ratio: 0.5,
        focusedPaneIdx: 0,
      };
      queueMicrotask(() => setActiveTabId(newTab.id));
      return [...prev, newTab];
    });
  }, [showToast]);

  // closePane drops one pane from its tab. Last-pane close removes the
  // whole tab. Primary close promotes secondary (panes.shift()).
  // tabsRef mirrors tabs for closures that need to inspect current state
  // without listing tabs as a dep (e.g. closePane reads it to find the
  // dying pane's claudeUuid before mutating).
  const tabsRef = useRef(tabs);
  useEffect(() => {
    tabsRef.current = tabs;
  }, [tabs]);

  const closePane = useCallback((c3Id: string) => {
    const hit = findPane(tabsRef.current, c3Id);
    if (!hit) return;
    const { tab, idx } = hit;
    disposeTerm(tab.panes[idx]!.claudeUuid);
    setTabs((prev) => {
      const hitNow = findPane(prev, c3Id);
      if (!hitNow) return prev;
      const t = hitNow.tab;
      const remaining = t.panes.length === 1
        ? []
        : hitNow.idx === 0
          ? [t.panes[1]!]
          : [t.panes[0]];
      if (remaining.length === 0) {
        const nextTabs = prev.filter((tt) => tt.id !== t.id);
        if (activeTabIdRef.current === t.id) {
          queueMicrotask(() => {
            setActiveTabId(nextTabs.length ? nextTabs[nextTabs.length - 1].id : null);
          });
        }
        return nextTabs;
      }
      return prev.map((tt) =>
        tt.id === t.id
          ? { ...tt, panes: [remaining[0]!] as [Pane], focusedPaneIdx: 0 }
          : tt,
      );
    });
  }, []);

  // closeTab drops all panes of a tab. Used by the × button + Delete
  // shortcut on the tab strip.
  const closeTab = useCallback((tabId: string) => {
    const target = tabsRef.current.find((t) => t.id === tabId);
    if (!target) return;
    for (const p of target.panes) disposeTerm(p.claudeUuid);
    setTabs((prev) => {
      const nextTabs = prev.filter((t) => t.id !== tabId);
      if (activeTabIdRef.current === tabId) {
        queueMicrotask(() => {
          setActiveTabId(nextTabs.length ? nextTabs[nextTabs.length - 1].id : null);
        });
      }
      return nextTabs;
    });
  }, []);

  // closePaneByC3 is used by Sidebar when a session row is removed —
  // close any open pane attached to that c3Id.
  const closePaneByC3 = useCallback((c3Id: string) => {
    closePane(c3Id);
  }, [closePane]);

  const reorderTabs = useCallback((nextTabIds: string[]) => {
    setTabs((prev) => {
      const byId = new Map(prev.map((t) => [t.id, t]));
      const reordered: Tab[] = [];
      for (const id of nextTabIds) {
        const t = byId.get(id);
        if (t) {
          reordered.push(t);
          byId.delete(id);
        }
      }
      for (const t of byId.values()) reordered.push(t);
      return reordered;
    });
  }, []);

  const setRatio = useCallback((tabId: string, ratio: number) => {
    setTabs((prev) =>
      prev.map((t) => (t.id === tabId ? { ...t, ratio } : t)),
    );
  }, []);

  // ---- URL + layout sidecar hydration -------------------------------------
  const hydratedRef = useRef(false);
  useEffect(() => {
    if (hydratedRef.current) return;
    if (sessions === null) return;
    hydratedRef.current = true;

    void (async () => {
      const layout = await loadLayout();
      const urlIds = initialUrlStateRef.current.ids;
      const urlActive = initialUrlStateRef.current.active;
      const byC3 = new Map(sessions.map((s) => [s.id, s]));
      const { tabs: rehydrated, activeTabId: rehydratedActive } = rehydrateTabs({
        layout,
        urlIds,
        urlActive,
        byC3,
      });
      if (rehydrated.length === 0) return;
      setTabs(rehydrated);
      setActiveTabId(rehydratedActive);
    })();
  }, [sessions]);

  // Mirror tabs/active into URL (flat: primary-pane c3Ids only).
  useEffect(() => {
    if (!hydratedRef.current) return;
    const activeTab = tabs.find((t) => t.id === activeTabId);
    writeTabUrl({
      ids: tabs.map((t) => primaryPane(t).c3Id),
      active: activeTab ? primaryPane(activeTab).c3Id : null,
    });
  }, [tabs, activeTabId]);

  // Persist to sidecar (debounced).
  useLayoutSync(tabs, activeTabId, hydratedRef.current);

  // ---- pane status patchers ------------------------------------------------
  const killTab = useCallback(
    (tabId: string) => {
      const t = tabs.find((tt) => tt.id === tabId);
      if (!t) return;
      const target = focusedPane(t);
      const entry = getTerm(target.claudeUuid);
      const ws = entry?.ws;
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        showToast(
          'WS disconnected; cannot kill PTY remotely. Use `pkill claude` to terminate.',
          { variant: 'warning' },
        );
        return;
      }
      ws.send(JSON.stringify({ type: 'kill' }));
      setTabs((prev) => patchPaneByC3(prev, target.c3Id, { killing: true }));
      window.setTimeout(() => {
        setTabs((prev) =>
          patchPanesByUuid(prev, target.claudeUuid, (p) =>
            p.killing && p.status !== 'exited' ? { ...p, killing: false } : p,
          ),
        );
      }, 3000);
    },
    [showToast, tabs],
  );

  const onKicked = useCallback(
    (uuid: string) => {
      setTabs((prev) =>
        patchPanesByUuid(prev, uuid, (p) => ({ ...p, status: 'kicked' })),
      );
      showToast('Session attached elsewhere — this tab was disconnected.', {
        variant: 'warning',
      });
    },
    [showToast],
  );

  const onExit = useCallback(
    (uuid: string, code: number) => {
      setTabs((prev) =>
        patchPanesByUuid(prev, uuid, (p) => ({
          ...p,
          status: 'exited',
          exitCode: code,
          killing: false,
        })),
      );
      showToast(`claude exited (code ${code}).`, { variant: 'info' });
    },
    [showToast],
  );

  const onStatus = useCallback((uuid: string, status: TabStatus) => {
    setTabs((prev) =>
      patchPanesByUuid(prev, uuid, (p) => {
        if (p.status === 'kicked' || p.status === 'exited') return p;
        if (p.status === 'pending' && status === 'connected') return p;
        if (p.status === 'error' && status === 'disconnected') return p;
        if (status === 'connecting' || status === 'connected') {
          return { ...p, status, errorMessage: undefined };
        }
        return { ...p, status };
      }),
    );
  }, []);

  const onError = useCallback((uuid: string, message: string) => {
    setTabs((prev) =>
      patchPanesByUuid(prev, uuid, (p) => ({ ...p, status: 'error', errorMessage: message })),
    );
    showToast(`Attach failed: ${message}`, { variant: 'error' });
  }, [showToast]);

  const onReady = useCallback(
    (uuid: string) => {
      setTabs((prev) =>
        patchPanesByUuid(prev, uuid, (p) => ({ ...p, status: 'connected' })),
      );
      showToast('Session ready.', { variant: 'success' });
      void refresh();
    },
    [refresh, showToast],
  );

  const onPending = useCallback((uuid: string) => {
    setTabs((prev) =>
      patchPanesByUuid(prev, uuid, (p) => ({ ...p, status: 'pending' })),
    );
  }, []);

  // ---- split active tab ---------------------------------------------------
  // Single-step: caller picks the kind (Claude/Shell/Bind) via the tab-strip
  // split menu (or Mod+\ which defaults to claude). No "awaiting" state —
  // each invocation either succeeds or surfaces a toast immediately.
  const splitActiveTab = useCallback(
    async (kind: 'claude' | 'shell' | 'bind') => {
      if (!activeTabId) return;
      const tab = tabs.find((tt) => tt.id === activeTabId);
      if (!tab) return;
      if (tab.panes.length === 2) return; // already split
      if (kind === 'bind') {
        // Bind needs an existing-uuid picker; defer to the sidebar's Bind
        // form rather than duplicating it inside the split affordance.
        setSidebarOpen(true);
        showToast('Use the ↪ icon in the sidebar to bind a session, then split again.', {
          variant: 'info',
        });
        return;
      }
      const seedCwd = primaryPane(tab).cwd || '';
      const name = kind === 'shell' ? 'shell' : 'claude';
      try {
        const entry = await createSession({
          cwd: seedCwd,
          name,
          kind: kind === 'shell' ? 'shell' : undefined,
        });
        setTabs((prev) =>
          prev.map((t) => {
            if (t.id !== activeTabId) return t;
            if (t.panes.length === 2) return t; // race
            const pane = paneFromEntry(entry);
            return {
              ...t,
              panes: [t.panes[0], pane] as [Pane, Pane],
              focusedPaneIdx: 1,
            };
          }),
        );
        void refresh();
      } catch (e) {
        showToast(
          `Split failed — ${e instanceof Error ? e.message : 'create session error'}`,
          { variant: 'error' },
        );
      }
    },
    [activeTabId, refresh, showToast, tabs],
  );

  // ---- hotkeys: split + pane cycle + close pane ---------------------------
  useShortcut(
    {
      id: 'pane.split',
      // Mod+d is bookmark-this-page in browsers; preventDefault works on
      // Chrome but fires *after* the dialog on Safari. Mod+\ is tmux's
      // prefix-\ for horizontal split and is unbound in all major
      // browsers — safer choice.
      keys: 'Mod+\\',
      scope: 'global',
      label: 'Split active tab',
      when: () => notInInput() && !!activeTabId,
      // Default to Claude (most common); user picks Shell/Bind via the
      // tab-strip split menu's expanded icons.
      handler: () => void splitActiveTab('claude'),
      preventDefault: true,
    },
    [activeTabId, splitActiveTab],
  );
  // Focus-cycle hotkeys (Mod+Shift+[ / Mod+Shift+]) intentionally NOT
  // registered: split UX is primarily click-driven; click any pane to
  // focus it. Adding two more keys for a 2-pane toggle would clutter
  // the Cheatsheet for marginal benefit. Reintroduce if/when N≥3.
  useShortcut(
    {
      id: 'pane.close.focused',
      // Use Mod+Shift+w to avoid the Mod+w browser tab-close binding.
      keys: 'Mod+Shift+w',
      scope: 'global',
      label: 'Close focused pane',
      when: () => notInInput() && !!activeTabId,
      handler: () => {
        const t = tabs.find((tt) => tt.id === activeTabId);
        if (!t) return;
        closePane(focusedPane(t).c3Id);
      },
      preventDefault: true,
    },
    [activeTabId, tabs, closePane],
  );

  // ---- palette helpers -----------------------------------------------------
  const closeAllTabs = useCallback(() => {
    for (const t of tabs) for (const p of t.panes) disposeTerm(p.claudeUuid);
    setTabs([]);
    setActiveTabId(null);
  }, [tabs]);
  const archiveActive = useCallback(async () => {
    const t = tabs.find((x) => x.id === activeTabId);
    if (!t) return;
    const primary = primaryPane(t);
    const entry = sessions?.find((s) => s.id === primary.c3Id) ?? null;
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
  }, [activeTabId, refresh, sessions, showToast, tabs]);
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
    openNewSession: () => startCreatingSession(),
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

  const activeTab = tabs.find((t) => t.id === activeTabId) ?? null;
  const activeC3Id = activeTab ? focusedPane(activeTab).c3Id : null;
  const activePane: Pane | null = activeTab ? focusedPane(activeTab) : null;

  // Auto-focus the active pane's xterm whenever the active tab or the
  // focused pane changes — so switching tabs (click / palette / keyboard)
  // or focusing a split pane lets the user type immediately, no second
  // click into the terminal. rAF so the focus lands after the pane's
  // visibility toggle settles in the DOM. Skipped while an overlay owns
  // focus (NewSessionPane prompt, palette, cheatsheet, dims dialog) so we
  // don't yank focus out from under those inputs.
  const overlayOpen = creatingSession || paletteOpen || cheatsheetOpen || dimsDialogOpen;
  useEffect(() => {
    if (!activeC3Id || overlayOpen) return;
    const uuid = activePane?.claudeUuid;
    if (!uuid) return;
    const raf = requestAnimationFrame(() => {
      try { getTerm(uuid)?.term.focus(); } catch { /* term may be disposing */ }
    });
    return () => cancelAnimationFrame(raf);
  }, [activeC3Id, overlayOpen, activePane?.claudeUuid]);

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
          activeC3Id={activeC3Id}
          openTabs={tabs}
          view={view}
          onViewChange={setView}
          onOpen={openTab}
          onRefresh={refresh}
          onSessionSelected={narrow ? closeDrawer : undefined}
          onAfterMutate={refresh}
          onCloseTabFor={closePaneByC3}
          narrow={narrow}
          showToast={showToast}
          openNewSessionTick={openNewSessionTick}
          onRequestCreate={() => {
            if (narrow) {
              setSidebarOpen(false);
              userTouched.current = true;
              writeSidebarPref(false);
            }
            startCreatingSession();
          }}
          onCloseMainPane={() => setCreatingSession(false)}
        />
      </div>
      <main className="workspace">
        {/* Hide the tab strip at ≤1 tab — a lone tab pill just duplicates
            the status-bar read-out. The split affordance moved to the
            StatusBar so it survives this. */}
        {tabs.length > 1 && (
          <TabBar
            tabs={tabs}
            activeTabId={activeTabId}
            onSelect={activateTab}
            onCloseTab={closeTab}
            onKill={killTab}
            onReorder={reorderTabs}
          />
        )}
        <div className="pane-host">
          {creatingSession ? (
            <>
              <NewSessionPane
                onCreated={(entry) => {
                  openTab(entry);
                  setCreatingSession(false);
                }}
                onCancel={() => setCreatingSession(false)}
                showToast={showToast}
                flashKey={paneFlashKey}
              />
              {tabs.map((tab) => (
                <SplitContainer
                  key={tab.id}
                  tab={tab}
                  visible={false}
                  onStatus={onStatus}
                  onKicked={onKicked}
                  onExit={onExit}
                  onPending={onPending}
                  onReady={onReady}
                  onError={onError}
                  onClosePane={closePane}
                  onMention={onMention}
                  onFocusPane={focusPane}
                  onRatioChange={setRatio}
                  colCap={colCap}
                  rowCap={rowCap}
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
              <SplitContainer
                key={tab.id}
                tab={tab}
                visible={tab.id === activeTabId}
                onStatus={onStatus}
                onKicked={onKicked}
                onExit={onExit}
                onPending={onPending}
                onReady={onReady}
                onError={onError}
                onClosePane={closePane}
                onMention={onMention}
                onFocusPane={focusPane}
                onRatioChange={setRatio}
                colCap={colCap}
                rowCap={rowCap}
              />
            ))
          )}
        </div>
        {(() => {
          let pulse = 0;
          if (activePane) {
            for (let i = 0; i < activePane.status.length; i++) {
              pulse = (pulse * 31 + activePane.status.charCodeAt(i)) | 0;
            }
          }
          return (
            <StatusBar
              activeTab={activePane}
              pulse={pulse}
              themeName={themeName}
              onThemeChange={onThemeChange}
              onOpenDims={() => setDimsDialogOpen(true)}
              canSplit={!!activeTab && activeTab.panes.length === 1}
              onSplitActive={(kind) => void splitActiveTab(kind)}
              onCopyCwd={(cwd) => {
                if (!cwd) return;
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
        activeTabId={activeTabId}
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
      {(() => {
        const t = activePane ? getTerm(activePane.claudeUuid) : null;
        const vCols = t?.term.cols ?? 0;
        const vRows = t?.term.rows ?? 0;
        return (
          <PtyDimsDialog
            open={dimsDialogOpen}
            colCap={colCap}
            rowCap={rowCap}
            viewportCols={vCols}
            viewportRows={vRows}
            onApply={applyDims}
            onClose={() => setDimsDialogOpen(false)}
          />
        );
      })()}
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
