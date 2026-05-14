// Mirrors core.C2Entry shape returned by GET /api/sessions.
// We don't import the Go type; keep this file in sync manually if the
// server schema changes.
export interface C2Entry {
  id: string;
  name: string;
  cwd: string;
  claudeUuid: string;
  createdAt: string;
}

export type ControlMsg =
  | { type: 'kicked' }
  | { type: 'exit'; code: number }
  | { type: 'error'; message?: string };

// UI-side tab status. Drives the badge in the tab strip and the overlay
// shown over the terminal pane.
export type TabStatus =
  | 'connecting'
  | 'connected'
  | 'disconnected'
  | 'kicked'
  | 'exited'
  | 'error';

export interface Tab {
  claudeUuid: string;
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
}
