// Out-of-React store for xterm.js instances. xterm objects are not
// React state — they own a DOM subtree, an animation frame loop, and a
// WebSocket. Re-rendering should never recreate them.
//
// Keyed by claudeUuid: the server treats uuid as PTY identity, so the
// same uuid in two tabs would clobber each other anyway (single-attach
// kick). Map keying enforces that invariant client-side too.
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';

export interface TermEntry {
  term: Terminal;
  fit: FitAddon;
  ws: WebSocket | null;
  // Owns the parent <div> attached to the DOM by the React pane.
  // React component is responsible for mounting/unmounting this element;
  // we just hold a reference so re-mount can call term.open() again only
  // if needed.
  container: HTMLDivElement | null;
  // Debounce timer for resize ioctl coalescing.
  resizeTimer: number | null;
  // Last sent dimensions, to skip redundant resize frames.
  lastCols: number;
  lastRows: number;
}

const terms = new Map<string, TermEntry>();

export function getOrCreateTerm(uuid: string): TermEntry {
  const existing = terms.get(uuid);
  if (existing) return existing;
  const term = new Terminal({
    fontFamily: "'JetBrains Mono', 'SF Mono', Menlo, monospace",
    fontSize: 13,
    cursorBlink: true,
    convertEol: false,
    scrollback: 10000,
    theme: {
      background: '#1e1e1e',
      foreground: '#d4d4d4',
      cursor: '#d4d4d4',
    },
    allowProposedApi: true,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  const entry: TermEntry = {
    term,
    fit,
    ws: null,
    container: null,
    resizeTimer: null,
    lastCols: 0,
    lastRows: 0,
  };
  terms.set(uuid, entry);
  return entry;
}

export function getTerm(uuid: string): TermEntry | undefined {
  return terms.get(uuid);
}

export function disposeTerm(uuid: string) {
  const e = terms.get(uuid);
  if (!e) return;
  try {
    e.ws?.close();
  } catch {
    /* ignore */
  }
  try {
    e.term.dispose();
  } catch {
    /* ignore */
  }
  if (e.resizeTimer) window.clearTimeout(e.resizeTimer);
  terms.delete(uuid);
}

export function allUuids(): string[] {
  return Array.from(terms.keys());
}
