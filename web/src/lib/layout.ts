// Sidecar persistence for split-panel layout. The URL hash stays flat
// (primary-pane c3Ids only) for back-compat with bookmarks and old
// builds; secondary panes + ratio + focus + tab.id live in the layout
// sidecar at ~/.local/share/c3/layout.json (server-owned).
//
// Server is opaque about schema — it parses JSON, caps body at 64 KiB,
// atomic-writes. All schema knowledge is here.

import { useEffect, useRef } from 'react';
import type { C3Entry, Pane, Tab } from '../types';
import { newTabId } from '../types';

const SCHEMA_VERSION = 1;
const SAVE_DEBOUNCE_MS = 250;

export interface SerializedPane {
  c3Id: string;
}

export interface SerializedTab {
  id: string;
  orientation: 'h';
  ratio: number;
  focusedPaneIdx: 0 | 1;
  panes: SerializedPane[];
}

export interface SerializedLayout {
  version: number;
  activeTabId: string | null;
  tabs: SerializedTab[];
}

// loadLayout fetches the sidecar. Returns null when the server has no
// file yet (204) OR when the payload fails validation — caller should
// fall back to URL-only restore.
export async function loadLayout(): Promise<SerializedLayout | null> {
  let resp: Response;
  try {
    resp = await fetch('/api/layout', { credentials: 'same-origin' });
  } catch {
    return null;
  }
  if (resp.status === 204) return null;
  if (!resp.ok) return null;
  let body: unknown;
  try {
    body = await resp.json();
  } catch {
    return null;
  }
  if (!body || typeof body !== 'object') return null;
  const obj = body as { version?: number; activeTabId?: unknown; tabs?: unknown };
  if (obj.version !== SCHEMA_VERSION) return null;
  if (!Array.isArray(obj.tabs)) return null;
  const tabs: SerializedTab[] = [];
  for (const raw of obj.tabs) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    const id = typeof r.id === 'string' && r.id ? r.id : null;
    const ratio = typeof r.ratio === 'number' && r.ratio >= 0.1 && r.ratio <= 0.9
      ? r.ratio
      : 0.5;
    const focusedPaneIdx = r.focusedPaneIdx === 1 ? 1 : 0;
    const orientation: 'h' = 'h'; // v1 only — ignore anything else
    if (!id || !Array.isArray(r.panes) || r.panes.length === 0 || r.panes.length > 2) {
      continue;
    }
    const panes: SerializedPane[] = [];
    for (const p of r.panes) {
      if (!p || typeof p !== 'object') continue;
      const pp = p as Record<string, unknown>;
      if (typeof pp.c3Id !== 'string' || !pp.c3Id) continue;
      panes.push({ c3Id: pp.c3Id });
    }
    if (panes.length === 0) continue;
    tabs.push({
      id,
      orientation,
      ratio,
      focusedPaneIdx: panes.length === 2 ? focusedPaneIdx : 0,
      panes,
    });
  }
  const activeTabId =
    typeof obj.activeTabId === 'string' && tabs.some((t) => t.id === obj.activeTabId)
      ? obj.activeTabId
      : null;
  return { version: SCHEMA_VERSION, activeTabId, tabs };
}

// saveLayout PUTs the sidecar. Errors are swallowed — persistence is
// best-effort; the live URL hash already restores the primary panes.
export async function saveLayout(layout: SerializedLayout): Promise<void> {
  try {
    await fetch('/api/layout', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(layout),
    });
  } catch {
    /* swallow */
  }
}

// Project an in-memory tab list to the on-disk schema.
export function serializeLayout(tabs: Tab[], activeTabId: string | null): SerializedLayout {
  return {
    version: SCHEMA_VERSION,
    activeTabId,
    tabs: tabs.map((t) => ({
      id: t.id,
      orientation: t.orientation,
      ratio: t.ratio,
      focusedPaneIdx: t.focusedPaneIdx,
      panes: t.panes.map((p) => ({ c3Id: p.c3Id })),
    })),
  };
}

// Build a Pane from a C3Entry. Centralised so URL-restore, layout-
// restore, and the live openTab path all agree on field defaults.
export function paneFromEntry(entry: C3Entry): Pane {
  const isShell = entry.kind === 'shell';
  const claudeUuid = entry.claudeUuid || entry.id;
  return {
    c3Id: entry.id,
    claudeUuid,
    name: entry.name || entry.id,
    cwd: entry.cwd || '',
    status: isShell || entry.claudeUuid ? 'connecting' : 'pending',
    kind: isShell ? 'shell' : 'claude',
  };
}

// rehydrate merges the layout sidecar with the URL hash. URL ids that
// resolve to live entries are appended as 1-pane tabs when no matching
// layout tab claims them; layout tabs whose c3Ids are all gone are
// dropped. Layout wins for ratio / focused / pane ordering when both
// sources contain the same c3Id.
export interface RehydrateInput {
  layout: SerializedLayout | null;
  urlIds: string[];
  urlActive: string | null;
  byC3: Map<string, C3Entry>;
}
export interface RehydrateResult {
  tabs: Tab[];
  activeTabId: string | null;
}

export function rehydrateTabs(input: RehydrateInput): RehydrateResult {
  const { layout, urlIds, urlActive, byC3 } = input;

  const claimed = new Set<string>(); // c3Ids already placed in a tab
  const tabs: Tab[] = [];

  if (layout) {
    for (const lt of layout.tabs) {
      const panes: Pane[] = [];
      for (const lp of lt.panes) {
        if (claimed.has(lp.c3Id)) continue; // belt-and-braces vs. dupes
        const entry = byC3.get(lp.c3Id);
        if (!entry) continue;
        panes.push(paneFromEntry(entry));
        claimed.add(lp.c3Id);
      }
      if (panes.length === 0) continue;
      const focusedPaneIdx = panes.length === 2 ? lt.focusedPaneIdx : 0;
      tabs.push({
        id: lt.id,
        orientation: 'h',
        ratio: lt.ratio,
        focusedPaneIdx,
        panes: panes.length === 2 ? [panes[0], panes[1]] : [panes[0]],
      });
    }
  }

  // URL ids that no layout tab claimed → append as fresh 1-pane tabs in
  // URL order, preserving the user's previous open set.
  for (const id of urlIds) {
    if (claimed.has(id)) continue;
    const entry = byC3.get(id);
    if (!entry) continue;
    claimed.add(id);
    tabs.push({
      id: newTabId(),
      orientation: 'h',
      ratio: 0.5,
      focusedPaneIdx: 0,
      panes: [paneFromEntry(entry)],
    });
  }

  // Active tab: prefer URL ?active=<c3Id> (resolve to its tab); else the
  // sidecar's activeTabId; else first.
  let activeTabId: string | null = null;
  if (urlActive) {
    const hit = tabs.find((t) => t.panes.some((p) => p.c3Id === urlActive));
    if (hit) activeTabId = hit.id;
  }
  if (!activeTabId && layout?.activeTabId) {
    const hit = tabs.find((t) => t.id === layout.activeTabId);
    if (hit) activeTabId = hit.id;
  }
  if (!activeTabId && tabs.length > 0) activeTabId = tabs[0].id;
  return { tabs, activeTabId };
}

// useLayoutSync debounces saves on every (tabs, activeTabId) mutation.
// Suppresses the initial-render save so rehydrate doesn't immediately
// PUT the same payload back to the server.
export function useLayoutSync(tabs: Tab[], activeTabId: string | null, ready: boolean): void {
  const firstRef = useRef(true);
  useEffect(() => {
    if (!ready) return;
    if (firstRef.current) {
      firstRef.current = false;
      return;
    }
    const id = window.setTimeout(() => {
      void saveLayout(serializeLayout(tabs, activeTabId));
    }, SAVE_DEBOUNCE_MS);
    return () => window.clearTimeout(id);
  }, [tabs, activeTabId, ready]);
}
