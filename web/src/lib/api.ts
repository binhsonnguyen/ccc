import type { C2Entry } from '../types';

export async function listSessions(): Promise<C2Entry[]> {
  const r = await fetch('/api/sessions');
  if (!r.ok) throw new Error(`GET /api/sessions: ${r.status}`);
  return (await r.json()) ?? [];
}

export function ptyWsURL(claudeUuid: string): string {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}/api/sessions/${encodeURIComponent(claudeUuid)}/pty`;
}
