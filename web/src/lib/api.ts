import type { C2Entry, ClaudeSessionsResponse } from '../types';

// All mutating routes need Content-Type so the server's json.Decoder gets
// the body; Origin is set automatically by the browser to the page origin
// so the same-origin CSRF guard passes.
const JSON_HEADERS = { 'Content-Type': 'application/json' };

interface ListOpts {
  archived?: boolean;
  includeLive?: boolean;
}

export async function listSessions(opts: ListOpts = {}): Promise<C2Entry[]> {
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

export async function renameSession(id: string, name: string): Promise<C2Entry> {
  const r = await fetch(`/api/sessions/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: JSON_HEADERS,
    body: JSON.stringify({ name }),
  });
  if (!r.ok) throw await readError(r);
  return (await r.json()) as C2Entry;
}

export async function removeSession(id: string, force = false): Promise<void> {
  const qs = force ? '?force=1' : '';
  const r = await fetch(`/api/sessions/${encodeURIComponent(id)}${qs}`, {
    method: 'DELETE',
    headers: JSON_HEADERS,
  });
  if (!r.ok) throw await readError(r);
}

export async function createSession(cwd: string, name: string): Promise<C2Entry> {
  const r = await fetch('/api/sessions', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ cwd, name }),
  });
  if (!r.ok) throw await readError(r);
  return (await r.json()) as C2Entry;
}

export async function bindSession(id: string, claudeUuid: string): Promise<C2Entry> {
  const r = await fetch(`/api/sessions/${encodeURIComponent(id)}/bind`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ claudeUuid }),
  });
  if (!r.ok) throw await readError(r);
  return (await r.json()) as C2Entry;
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
export async function fetchSessionTail(c2Id: string, bytes = 2048): Promise<string> {
  const r = await fetch(
    `/api/sessions/${encodeURIComponent(c2Id)}/tail?bytes=${bytes}`,
  );
  if (r.status === 204) return '';
  if (!r.ok) throw await readError(r);
  return await r.text();
}

export function ptyWsURL(c2Id: string): string {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}/api/sessions/${encodeURIComponent(c2Id)}/pty`;
}
