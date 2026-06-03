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

export function loadSidebarLayout(): SidebarLayout {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return EMPTY;
    const parsed = JSON.parse(raw) as unknown;
    if (isValidLayout(parsed)) return parsed;
  } catch {
    // ignore parse/access errors
  }
  return EMPTY;
}

export function saveSidebarLayout(l: SidebarLayout): void {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(l));
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
