import type { C3Entry, ClaudeSessionsResponse } from '../types';

// All mutating routes need Content-Type so the server's json.Decoder gets
// the body; Origin is set automatically by the browser to the page origin
// so the same-origin CSRF guard passes.
const JSON_HEADERS = { 'Content-Type': 'application/json' };

interface ListOpts {
  archived?: boolean;
  includeLive?: boolean;
}

export async function listSessions(opts: ListOpts = {}): Promise<C3Entry[]> {
  const qs = new URLSearchParams();
  if (opts.archived) qs.set('archived', 'true');
  if (opts.includeLive) qs.set('include', 'live');
  const suffix = qs.toString() ? `?${qs.toString()}` : '';
  const r = await fetch(`/api/sessions${suffix}`);
  if (!r.ok) throw new Error(`GET /api/sessions: ${r.status}`);
  return (await r.json()) ?? [];
}

export class ApiError extends Error {
  status: number;
  body: string;
  constructor(status: number, body: string) {
    // Server emits "validation failed: cwd: ..." style strings on 400 and
    // free-form text on other failures; surface verbatim so the UI can
    // show it inline.
    super(body || `HTTP ${status}`);
    this.status = status;
    this.body = body;
  }
}

async function readError(r: Response): Promise<ApiError> {
  let body = '';
  try {
    body = (await r.text()).trim();
  } catch {
    /* ignore */
  }
  return new ApiError(r.status, body);
}

export async function archiveSession(id: string): Promise<{ archived: boolean }> {
  const r = await fetch(`/api/sessions/${encodeURIComponent(id)}/archive`, {
    method: 'POST',
    headers: JSON_HEADERS,
  });
  if (!r.ok) throw await readError(r);
  return (await r.json()) as { archived: boolean };
}

export async function renameSession(id: string, name: string): Promise<C3Entry> {
  const r = await fetch(`/api/sessions/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: JSON_HEADERS,
    body: JSON.stringify({ name }),
  });
  if (!r.ok) throw await readError(r);
  return (await r.json()) as C3Entry;
}

export async function removeSession(id: string, force = false): Promise<void> {
  const qs = force ? '?force=1' : '';
  const r = await fetch(`/api/sessions/${encodeURIComponent(id)}${qs}`, {
    method: 'DELETE',
    headers: JSON_HEADERS,
  });
  if (!r.ok) throw await readError(r);
}

export async function createSession(cwd: string, name: string): Promise<C3Entry> {
  const r = await fetch('/api/sessions', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ cwd, name }),
  });
  if (!r.ok) throw await readError(r);
  return (await r.json()) as C3Entry;
}

export async function bindSession(id: string, claudeUuid: string): Promise<C3Entry> {
  const r = await fetch(`/api/sessions/${encodeURIComponent(id)}/bind`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ claudeUuid }),
  });
  if (!r.ok) throw await readError(r);
  return (await r.json()) as C3Entry;
}

export async function listClaudeSessions(): Promise<ClaudeSessionsResponse> {
  const r = await fetch('/api/claude-sessions');
  if (!r.ok) throw await readError(r);
  const j = await r.json();
  return {
    unbound: j?.unbound ?? [],
    cwds: j?.cwds ?? [],
  };
}

// fetchSessionTail returns up to `bytes` raw bytes (ANSI escapes
// preserved) from the live PTY scrollback. Empty string when no live
// PTY (server returns 204) so callers can render a placeholder.
export async function fetchSessionTail(c3Id: string, bytes = 2048): Promise<string> {
  const r = await fetch(
    `/api/sessions/${encodeURIComponent(c3Id)}/tail?bytes=${bytes}`,
  );
  if (r.status === 204) return '';
  if (!r.ok) throw await readError(r);
  return await r.text();
}

// ActivityResponse is the parsed shape of GET /api/sessions/:id/activity.
// `buckets` is the 60-bucket bytes/sec ring (oldest first). `idleMs` is
// milliseconds since the most recent PTY stdout read; the server measures
// this so client-clock skew can't poison the value.
export interface ActivityResponse {
  buckets: number[];
  idleMs: number;
}

// fetchActivity returns the activity ring + idle delta for a live session,
// or null when no live PTY exists (server 204). The sidebar polls this
// every ~2s for visible live rows to draw the sparkline; TerminalPane
// reuses the same poll for the idle-banner threshold check.
export async function fetchActivity(c3Id: string): Promise<ActivityResponse | null> {
  const r = await fetch(
    `/api/sessions/${encodeURIComponent(c3Id)}/activity`,
  );
  if (r.status === 204) return null;
  if (!r.ok) throw await readError(r);
  const j = (await r.json()) as { buckets?: number[]; idleMs?: number };
  return {
    buckets: j?.buckets ?? [],
    idleMs: j?.idleMs ?? 0,
  };
}

export function ptyWsURL(c3Id: string): string {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}/api/sessions/${encodeURIComponent(c3Id)}/pty`;
}
