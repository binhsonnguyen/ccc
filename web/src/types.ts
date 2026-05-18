// Mirrors core.C2Entry shape returned by GET /api/sessions.
// We don't import the Go type; keep this file in sync manually if the
// server schema changes.
export interface C2Entry {
  id: string;
  name: string;
  cwd: string;
  claudeUuid: string;
  createdAt: string;
  // live: present only when GET /api/sessions?include=live was requested.
  // True iff the ptymgr currently has an attached PTY for this entry's
  // claudeUuid (or pending c2-id while uuid is still empty).
  live?: boolean;
}

// Claude session record returned by GET /api/claude-sessions in the
// `unbound` array. Mirrors `claudefs.Session` fields the bind UI needs.
export interface ClaudeSession {
  uuid: string;
  cwd: string;
  // summary: Claude-generated session summary (first user prompt). Wire
  // field matches core.Session JSON tag.
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
  // D-7: server sends `pending` right after attach when entry has no
  // claudeUuid yet — claude is being spawned in no-resume mode while the
  // discovery loop watches for JSONL. Sidebar list polling will pick the
  // uuid up after `ready`.
  | { type: 'pending' }
  | { type: 'ready' };

// UI-side tab status. Drives the badge in the tab strip and the overlay
// shown over the terminal pane.
export type TabStatus =
  | 'connecting'
  | 'connected'
  | 'pending'
  | 'disconnected'
  | 'kicked'
  | 'exited'
  | 'error';

export interface Tab {
  // claudeUuid: dedup key (one tab per Claude session even if multiple
  // c2 entries point at it). For pending entries the c2 id is reused
  // here as a placeholder until the server upgrades the entry — the
  // sidebar refresh after `ready` swaps the tab over.
  claudeUuid: string;
  // c2Id: addressing key for /api/sessions/:id/pty WS route. The server
  // resolves entry by c2 id and looks up its claudeUuid internally.
  c2Id: string;
  name: string;
  cwd: string;
  status: TabStatus;
  exitCode?: number;
  // killing: set true after the user clicks Kill and we sent {type:"kill"}.
  // Cleared when the server responds with `exit` (onExit handler) or a
  // 3s safety timeout in App.killTab. While true, both Kill and × close
  // buttons are disabled to prevent spam-click while the server is
  // SIGKILL'ing the child.
  killing?: boolean;
  // C-5: count of regex matches in PTY output that arrived while this
  // tab was inactive. Cleared on activation. Undefined ≡ 0; rendered as
  // a small pill on inactive tabs in TabBar.
  mentions?: number;
}
