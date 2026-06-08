// Sidebar layout persistence — session order (Phase 1) and groups (Phase 2).
// All schema knowledge lives here; localStorage key is 'c3.sidebar-layout'.

import { useState, useCallback, useEffect, useRef } from 'react';
import { getSidebarLayout, putSidebarLayout } from './api';

export type SidebarGroup = {
  id: string;
  name: string;
  collapsed: boolean;
  memberOrder: string[]; // c3Ids
};

export type SidebarLayout = {
  version: 1;
  order: string[];        // c3Id (ungrouped) or "grp:<id>" (group block) — Phase 2
  groups: SidebarGroup[]; // Phase 2; Phase 1 always []
};

const LS_KEY = 'c3.sidebar-layout';
const EMPTY: SidebarLayout = { version: 1, order: [], groups: [] };

function isValidLayout(v: unknown): v is SidebarLayout {
  if (!v || typeof v !== 'object') return false;
  const l = v as Record<string, unknown>;
  return (
    l['version'] === 1 &&
    Array.isArray(l['order']) &&
    Array.isArray(l['groups'])
  );
}

// Enforce the load-bearing invariant: every group in `groups` has exactly one
// "grp:<id>" slot in `order`, and every "grp:" slot points at a real group.
// buildRenderItems treats `order` as the render source of truth, so a group
// present in `groups` but missing from `order` vanishes silently (header AND
// members — members are filtered out as "already grouped"). A prior version's
// per-scope order rebuild could drop slots, persisting an orphan into
// localStorage that never self-heals. Normalizing on both load and save makes
// the stored layout self-repairing and idempotent: orphaned groups get their
// slot re-appended, dangling slots are dropped, duplicates collapsed. Touches
// only `order` — never `groups`/`memberOrder` — so session data is untouched.
export function normalizeLayout(l: SidebarLayout): SidebarLayout {
  const groupIds = new Set(l.groups.map((g) => g.id));
  const seen = new Set<string>();
  const order = l.order.filter((s) => {
    if (seen.has(s)) return false; // dedup
    seen.add(s);
    if (s.startsWith('grp:')) return groupIds.has(s.slice(4)); // drop dangling
    return true;
  });
  // Re-attach any group whose slot fell out of `order` (orphan recovery).
  const inOrder = new Set(
    order.filter((s) => s.startsWith('grp:')).map((s) => s.slice(4)),
  );
  for (const g of l.groups) {
    if (!inOrder.has(g.id)) order.push('grp:' + g.id);
  }
  return { ...l, order };
}

export function loadSidebarLayout(): SidebarLayout {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return EMPTY;
    const parsed = JSON.parse(raw) as unknown;
    if (isValidLayout(parsed)) return normalizeLayout(parsed);
  } catch {
    // ignore parse/access errors
  }
  return EMPTY;
}

export function saveSidebarLayout(l: SidebarLayout): void {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(normalizeLayout(l)));
  } catch {
    // ignore quota errors
  }
}

const PUT_DEBOUNCE_MS = 400;

// Hook: returns [layout, setLayout].
//
// Persistence is two-tier. localStorage is a same-machine cache that gives an
// instant first paint and an offline fallback; the server sidecar
// (sidebar-layout.json) is the source of truth that makes groups portable
// across browsers/devices hitting the same daemon. On mount we paint from the
// cache immediately, then reconcile with the server: adopt the server copy if
// the user hasn't edited yet, or migrate the local copy up if the server has
// nothing. Each setLayout writes the cache synchronously and pushes to the
// server debounced.
export function useSidebarLayout(): [SidebarLayout, (l: SidebarLayout) => void] {
  const [layout, setLayoutState] = useState<SidebarLayout>(loadSidebarLayout);
  // True once the user has changed the layout this session, so the async
  // server load doesn't clobber an in-progress edit (load can resolve late).
  const dirtyRef = useRef(false);
  const putTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const pushToServer = useCallback((l: SidebarLayout) => {
    if (putTimer.current) clearTimeout(putTimer.current);
    putTimer.current = setTimeout(() => {
      void putSidebarLayout(normalizeLayout(l)).catch(() => {
        // Offline / server down: localStorage already holds the value, so the
        // change isn't lost; the next successful push reconciles the server.
      });
    }, PUT_DEBOUNCE_MS);
  }, []);

  const setLayout = useCallback(
    (l: SidebarLayout) => {
      dirtyRef.current = true;
      saveSidebarLayout(l);
      setLayoutState(l);
      pushToServer(l);
    },
    [pushToServer],
  );

  // Mount-time reconcile with the server (runs once).
  useEffect(() => {
    let cancelled = false;
    void getSidebarLayout()
      .then((remote) => {
        if (cancelled) return;
        if (remote && isValidLayout(remote)) {
          if (dirtyRef.current) return; // don't stomp a local edit in flight
          const norm = normalizeLayout(remote);
          saveSidebarLayout(norm); // refresh the cache to match the server
          setLayoutState(norm);
        } else if (!dirtyRef.current) {
          // Server has nothing yet: seed it from the local cache (migration
          // for users who grouped before persistence existed). Skip if the
          // user already edited (their own debounced push covers it) or the
          // local layout is empty — no point writing an empty file.
          const local = loadSidebarLayout();
          if (local.order.length || local.groups.length) {
            void putSidebarLayout(local).catch(() => {});
          }
        }
      })
      .catch(() => {
        // Server unreachable: stay on the cached layout.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Flush guard: cancel any pending debounced PUT on unmount so it doesn't
  // fire (and run normalizeLayout) against a stale closure after teardown.
  useEffect(() => {
    return () => {
      if (putTimer.current) clearTimeout(putTimer.current);
    };
  }, []);

  // Multi-tab sync (same machine): the `storage` event fires only in OTHER
  // tabs, so there's no feedback loop with setLayout. Adopting the persisted
  // value keeps every open tab in sync and stops a stale tab from later
  // overwriting with an outdated layout. This is a local read only — it does
  // not re-push to the server (the tab that wrote it already did).
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key !== null && e.key !== LS_KEY) return; // null = storage cleared
      setLayoutState(loadSidebarLayout());
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  return [layout, setLayout];
}
