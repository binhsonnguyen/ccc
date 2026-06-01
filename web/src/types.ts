// Mirrors core.C3Entry shape returned by GET /api/sessions.
// We don't import the Go type; keep this file in sync manually if the
// server schema changes.
export interface C3Entry {
  id: string;
  name: string;
  cwd: string;
  claudeUuid: string;
  createdAt: string;
  // live: present only when GET /api/sessions?include=live was requested.
  // True iff the ptymgr currently has an attached PTY for this entry's
  // claudeUuid (or pending c3-id while uuid is still empty).
  live?: boolean;
  // kind discriminates entry type. Absent ⇒ 'claude' (legacy). 'shell'
  // means a plain $SHELL -i tab — no claudeUuid, no transcript, no
  // discovery handshake.
  kind?: 'claude' | 'shell';
}

// Claude session record returned by GET /api/claude-sessions in the
// `unbound` array.
export interface ClaudeSession {
  uuid: string;
  cwd: string;
  summary?: string;
  modified?: string;
}

export interface ClaudeSessionsResponse {
  unbound: ClaudeSession[];
  cwds: string[];
}

export type ControlMsg =
  | { type: 'kicked' }
  | { type: 'exit'; code: number }
  | { type: 'error'; message?: string }
  | { type: 'pending' }
  | { type: 'ready' }
  | { type: 'turn_complete' };

// UI-side pane status. Drives the badge in the tab strip (derived from
// primary pane) and the overlay shown over the terminal pane.
export type TabStatus =
  | 'connecting'
  | 'connected'
  | 'pending'
  | 'disconnected'
  | 'kicked'
  | 'exited'
  | 'error';

// One attached PTY surface. Multiple panes can coexist inside a single
// Tab. The c3Id is the unique addressing key; claudeUuid is the term
// store / discovery key (set equal to c3Id for shell tabs and pending
// claude sessions until discovery rekeys).
export interface Pane {
  c3Id: string;
  claudeUuid: string;
  name: string;
  cwd: string;
  status: TabStatus;
  exitCode?: number;
  killing?: boolean;
  mentions?: number;
  errorMessage?: string;
  kind?: 'claude' | 'shell';
}

// A workspace tab. Holds 1 or 2 panes (binary split, v0.2.23). The
// `orientation` field exists for v2 forward-compat — v1 is always 'h'.
export interface Tab {
  // Stable client-generated id; survives renames, splits, focus changes,
  // and primary↔secondary swaps. Used as the React key and as the
  // sidecar layout.json key.
  id: string;
  panes: [Pane] | [Pane, Pane];
  orientation: 'h';
  ratio: number;          // 0.1..0.9, default 0.5
  focusedPaneIdx: 0 | 1;
}

// --- helpers ---------------------------------------------------------------

export function primaryPane(t: Tab): Pane {
  return t.panes[0];
}

export function focusedPane(t: Tab): Pane {
  const idx = t.focusedPaneIdx;
  if (idx === 1 && t.panes.length === 2) return t.panes[1]!;
  return t.panes[0];
}

export function paneCount(t: Tab): 1 | 2 {
  return t.panes.length as 1 | 2;
}

export function findPane(
  tabs: Tab[],
  c3Id: string,
): { tab: Tab; idx: 0 | 1 } | null {
  for (const t of tabs) {
    if (t.panes[0].c3Id === c3Id) return { tab: t, idx: 0 };
    if (t.panes.length === 2 && t.panes[1]!.c3Id === c3Id) return { tab: t, idx: 1 };
  }
  return null;
}

// True iff the c3Id is already attached in any open tab's panes. The
// App.openTab guard uses this to block a duplicate attach (single-PTY
// invariant).
export function paneOpen(tabs: Tab[], c3Id: string): boolean {
  return findPane(tabs, c3Id) !== null;
}

// Generate a stable client-side tab id. crypto.randomUUID() is in every
// supported browser (Chromium 92+, Safari 15.4+, Firefox 95+).
export function newTabId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // Fallback for ancient runtimes / tests: random hex.
  return 'tab-' + Math.random().toString(16).slice(2) + Date.now().toString(16);
}
