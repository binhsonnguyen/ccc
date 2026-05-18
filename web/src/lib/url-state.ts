// URL-routed tab state. Source of truth for "which tabs are open + which
// is active" lives in the URL hash so a reload restores the workspace.
//
// Format: `#/s/<c3Id>,<c3Id>,<c3Id>?active=<c3Id>`
// - Tab order = order in the comma list.
// - Active tab = `?active=<c3Id>` inside the hash, defaulting to the
//   first id when missing/unknown.
// - Unknown / duplicate ids on parse are silently dropped.

export interface TabUrlState {
  ids: string[];
  active: string | null;
}

const C3_ID_RE = /^[0-9a-f]{1,16}$/i;

export function parseTabUrl(hash: string): TabUrlState {
  // Strip the leading `#` then split off the `?...` query inside the hash.
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  const [path, query = ''] = raw.split('?');
  if (!path.startsWith('/s/')) return { ids: [], active: null };
  const rest = path.slice(3);
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const part of rest.split(',')) {
    const id = part.trim();
    if (!id || !C3_ID_RE.test(id) || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  let active: string | null = null;
  for (const kv of query.split('&')) {
    const eq = kv.indexOf('=');
    if (eq < 0) continue;
    if (kv.slice(0, eq) === 'active') {
      active = decodeURIComponent(kv.slice(eq + 1));
      break;
    }
  }
  if (active && !ids.includes(active)) active = null;
  return { ids, active };
}

export function serializeTabUrl(state: TabUrlState): string {
  if (state.ids.length === 0) return '';
  const path = `#/s/${state.ids.join(',')}`;
  const active = state.active && state.ids.includes(state.active) ? state.active : null;
  return active ? `${path}?active=${encodeURIComponent(active)}` : path;
}

// Replace the current URL hash without adding a history entry. We use
// replaceState (not pushState) so the back button doesn't step through
// every tab switch / close / reorder.
export function writeTabUrl(state: TabUrlState): void {
  if (typeof window === 'undefined') return;
  const next = serializeTabUrl(state);
  const url = window.location.pathname + window.location.search + next;
  if (window.location.hash === next) return;
  window.history.replaceState(window.history.state, '', url || window.location.pathname);
}
