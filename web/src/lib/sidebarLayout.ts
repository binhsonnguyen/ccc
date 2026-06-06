// Sidebar layout persistence — session order (Phase 1) and groups (Phase 2).
// All schema knowledge lives here; localStorage key is 'c3.sidebar-layout'.

import { useState, useCallback } from 'react';

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

// Hook: returns [layout, setLayout]. setLayout also writes to localStorage.
export function useSidebarLayout(): [SidebarLayout, (l: SidebarLayout) => void] {
  const [layout, setLayoutState] = useState<SidebarLayout>(loadSidebarLayout);

  const setLayout = useCallback((l: SidebarLayout) => {
    saveSidebarLayout(l);
    setLayoutState(l);
  }, []);

  return [layout, setLayout];
}
