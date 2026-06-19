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

interface CreateSessionOpts {
  cwd: string;
  name: string;
  // Optional inline first-prompt flow. When set together with
  // claudeUuid the server pre-binds the entry, stashes the prompt
  // in-memory, and the next WS attach spawns
  // `claude --session-id <uuid> <firstPrompt>` so the prompt
  // auto-submits in the TUI (no pending banner).
  firstPrompt?: string;
  claudeUuid?: string;
  // kind: 'claude' (default, omitted) or 'shell'.
  kind?: 'claude' | 'shell';
}

export async function createSession(opts: CreateSessionOpts): Promise<C3Entry> {
  const body: Record<string, unknown> = {
    cwd: opts.cwd,
    name: opts.name,
    firstPrompt: opts.firstPrompt ?? '',
    claudeUuid: opts.claudeUuid ?? '',
  };
  if (opts.kind) body.kind = opts.kind;
  const r = await fetch('/api/sessions', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
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

// SearchMatch mirrors adapters/claudefs.SearchMatch. One hit per Claude
// session; snippet is a ~60-char window centered on the match with ANSI
// stripped and line breaks collapsed (see search.go buildSnippet).
export interface SearchMatch {
  claudeUuid: string;
  cwd: string;
  summary?: string;
  snippet: string;
  matchedAt: string;
}

export interface SearchResponse {
  matches: SearchMatch[];
  truncated: boolean;
}

// searchSessions grep-scans Claude's JSONL files for `q` (case-insensitive).
// The server requires q to be ≥3 chars; the client also debounces before
// calling so a fast typist doesn't fire intermediate requests.
//
// The optional AbortSignal lets the sidebar supersede an in-flight query
// when the user keeps typing: stale responses throw AbortError which the
// caller swallows.
export async function searchSessions(
  q: string,
  limit = 20,
  signal?: AbortSignal,
): Promise<SearchResponse> {
  const qs = new URLSearchParams({ q, limit: String(limit) });
  const r = await fetch(`/api/sessions/search?${qs.toString()}`, { signal });
  if (!r.ok) throw await readError(r);
  const j = await r.json();
  return {
    matches: j?.matches ?? [],
    truncated: !!j?.truncated,
  };
}

// uploadImages POSTs one or more image blobs to the server, which writes
// them under the session's data dir and returns the absolute paths. The
// caller then injects "@<path> " into the PTY stdin — claude treats the
// mention exactly like a user-typed @path, so the image flows through
// claude's normal channel and ends up in the JSONL transcript.
//
// Multiple files are uploaded in one request (same "image" field repeated).
// Server-side ParseMultipartForm handles that natively.
export async function uploadImages(c3Id: string, files: File[]): Promise<string[]> {
  if (files.length === 0) return [];
  const fd = new FormData();
  for (const f of files) {
    fd.append('image', f, f.name || 'pasted-image');
  }
  const r = await fetch(
    `/api/sessions/${encodeURIComponent(c3Id)}/upload-image`,
    { method: 'POST', body: fd },
  );
  if (!r.ok) throw await readError(r);
  const j = (await r.json()) as { paths?: string[] };
  return j?.paths ?? [];
}

// Sidebar layout (session order + channel groups) sidecar. The server stores
// it opaquely at sidebar-layout.json; schema lives in sidebarLayout.ts. GET
// returns the stored JSON, or null when the server has nothing yet (204).
export async function getSidebarLayout(): Promise<unknown | null> {
  const r = await fetch('/api/sidebar-layout');
  if (r.status === 204) return null;
  if (!r.ok) throw new Error(`GET /api/sidebar-layout: ${r.status}`);
  return await r.json();
}

// putSidebarLayout persists the layout. Same-origin guarded server-side; the
// JSON content-type header is what makes the browser send Origin so the guard
// passes. Body is capped at 64 KiB by the server.
export async function putSidebarLayout(layout: unknown): Promise<void> {
  const r = await fetch('/api/sidebar-layout', {
    method: 'PUT',
    headers: JSON_HEADERS,
    body: JSON.stringify(layout),
  });
  if (!r.ok) throw new Error(`PUT /api/sidebar-layout: ${r.status}`);
}

// ---------------------------------------------------------------------------
// Provider profiles (LLM backend switch + token storage)
// ---------------------------------------------------------------------------

export interface ProviderProfile {
  id: string;
  label: string;
  baseUrl: string;
  // Whether a long-lived auth token is stored server-side. The token itself
  // is never sent to the browser.
  hasToken: boolean;
  env?: Record<string, string>;
}

export interface ProvidersResponse {
  // Active profile id; '' means passthrough (no env injection, the
  // pre-feature behaviour).
  active: string;
  profiles: ProviderProfile[];
}

export async function getProviders(): Promise<ProvidersResponse> {
  const r = await fetch('/api/providers');
  if (!r.ok) throw await readError(r);
  const j = await r.json();
  return { active: j?.active ?? '', profiles: j?.profiles ?? [] };
}

// setActiveProvider switches the global active profile. Applies to sessions
// started AFTER the call — running PTYs keep their spawn-time env. id '' is
// passthrough.
export async function setActiveProvider(id: string): Promise<void> {
  const r = await fetch('/api/providers/active', {
    method: 'PUT',
    headers: JSON_HEADERS,
    body: JSON.stringify({ id }),
  });
  if (!r.ok) throw await readError(r);
}

// setProviderToken stores (token === '' clears) the long-lived auth token
// for a profile. Write-only: the server never echoes it back.
export async function setProviderToken(id: string, token: string): Promise<void> {
  const r = await fetch('/api/providers/token', {
    method: 'PUT',
    headers: JSON_HEADERS,
    body: JSON.stringify({ id, token }),
  });
  if (!r.ok) throw await readError(r);
}

export function ptyWsURL(c3Id: string): string {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}/api/sessions/${encodeURIComponent(c3Id)}/pty`;
}
