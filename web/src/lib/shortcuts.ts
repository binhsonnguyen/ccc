// Central shortcut registry + global key dispatcher.
//
// Why this exists (PLAN.md P-3): components used to attach their own
// `window.addEventListener('keydown', ...)` listeners and read app state
// out of closure. That works, but it scatters key bindings across the
// tree, makes a future cheatsheet impossible to build automatically,
// and lets two handlers fire for the same key (the drawer ESC vs. the
// terminal-dead overlay ESC, for example). This file owns *one* global
// keydown listener and routes events to registered entries by scope.
//
// API summary:
//   registerShortcut(entry) -> unregister
//   useShortcut(entry, deps?) -> React hook wrapper
//   listShortcuts() -> for the future cheatsheet (P-2)
//
// Scope is resolved from `document.activeElement` at dispatch time:
//   - 'menu-focused'    : activeElement closest to [role="menu"]
//   - 'tab-focused'     : activeElement inside .tabbar
//   - 'sidebar-focused' : activeElement inside .sidebar (and not menu)
//   - 'global'          : anywhere else (also: 'global' entries match
//                         regardless of where focus is).
//
// Conflict policy: iteration is in registration order (Map preserves
// insertion). **All** matching entries fire — this preserves the
// pre-refactor behavior where each component attached its own keydown
// listener and any number of them could react to the same key (the
// canonical case: ESC inside the new-session modal closes the form
// *and* dismisses the drawer in narrow mode). Per-tab entries (e.g.
// `pane.close.${uuid}`) rely on the `when` predicate to keep only the
// visible tab firing. A handler that wants to be the sole responder
// should make its `when` predicate exclusive enough to not collide.
//
// `keys` canonical form built by keyToString(e):
//   Mod+Shift+Alt+<key>
// where Mod is metaKey on macOS and ctrlKey elsewhere, and <key> is the
// physical KeyboardEvent.key — 'Escape', 'ArrowLeft', 'Enter', 'Delete',
// 'Backspace', '/', and printables in their natural case ('k', not 'K').
//
// This file deliberately does *not* swallow events on its own. The
// dispatcher only calls preventDefault when an entry's handler runs and
// `preventDefault` is not explicitly set to false. Everything else
// (typing in inputs, terminal keystrokes via xterm.onData, focus trap
// Tab cycling, click-outside) stays the component's responsibility.

import { useEffect } from 'react';
import type { DependencyList } from 'react';

export type ShortcutScope =
  | 'global'
  | 'tab-focused'
  | 'sidebar-focused'
  | 'menu-focused';

export interface ShortcutEntry {
  // Unique id. Used as Map key (deregister + future cheatsheet rows).
  id: string;
  // Canonical form: 'Mod+K', 'Escape', 'ArrowLeft', 'Delete', '/', 'r'.
  keys: string;
  // Human-readable label for the cheatsheet (P-2).
  label: string;
  scope: ShortcutScope;
  handler: (e: KeyboardEvent) => void;
  // Default true. Set false for shortcuts that need to let the key
  // through (rarely useful — most call sites want preventDefault).
  preventDefault?: boolean;
  // Optional predicate evaluated at dispatch time. Skips the handler
  // when false. Used to gate per-instance entries (e.g. drawer-open).
  when?: () => boolean;
}

const registry = new Map<string, ShortcutEntry>();
let listenerAttached = false;

function isMac(): boolean {
  if (typeof navigator === 'undefined') return false;
  // navigator.platform is deprecated but still the most reliable proxy
  // for "should Mod mean Meta". userAgentData lacks platform on FF/Safari.
  return /Mac|iPhone|iPad|iPod/i.test(navigator.platform);
}

const MAC = isMac();

// Modifier order kept stable across producer (keyToString) and registrar
// so 'Mod+Shift+K' compares byte-for-byte against the dispatched form.
export function keyToString(e: KeyboardEvent): string {
  const parts: string[] = [];
  const mod = MAC ? e.metaKey : e.ctrlKey;
  if (mod) parts.push('Mod');
  if (e.shiftKey) parts.push('Shift');
  if (e.altKey) parts.push('Alt');
  // For pure modifier presses (Meta/Shift/Alt/Control) `e.key` is the
  // modifier name itself — skip those so a bare Shift press doesn't
  // ever match an entry by accident.
  let k = e.key;
  if (k === 'Meta' || k === 'Shift' || k === 'Alt' || k === 'Control') {
    return parts.join('+');
  }
  // Normalize single-character letters to lowercase so Shift+K and
  // shift+k canonicalize the same way. Registrants always write the
  // lowercase form ('k', 'r', 'a'); browsers report 'K' when Shift is
  // also down. Multi-char keys ('ArrowLeft', 'Escape', 'Enter') stay
  // as-is. Symbol keys like '?' and '/' are unaffected too.
  if (k.length === 1) k = k.toLowerCase();
  parts.push(k);
  return parts.join('+');
}

// formatKeys renders a registered key string for human display. The
// future cheatsheet (P-2) and tooltips share this so the in-app hint
// always matches what the dispatcher actually listens for.
export function formatKeys(keys: string): string {
  return keys
    .split('+')
    .map((p) => {
      if (p === 'Mod') return MAC ? '⌘' : 'Ctrl';
      if (p === 'Shift') return MAC ? '⇧' : 'Shift';
      if (p === 'Alt') return MAC ? '⌥' : 'Alt';
      if (p === ' ') return 'Space';
      if (p === 'ArrowLeft') return '←';
      if (p === 'ArrowRight') return '→';
      if (p === 'ArrowUp') return '↑';
      if (p === 'ArrowDown') return '↓';
      if (p.length === 1) return p.toUpperCase();
      return p;
    })
    .join(MAC ? '' : '+');
}

function resolveScope(el: Element | null): ShortcutScope {
  if (!el) return 'global';
  if (el.closest('[role="menu"]')) return 'menu-focused';
  if (el.closest('.tabbar')) return 'tab-focused';
  if (el.closest('.sidebar')) return 'sidebar-focused';
  return 'global';
}

function scopeMatches(entry: ShortcutScope, resolved: ShortcutScope): boolean {
  if (entry === 'global') return true;
  return entry === resolved;
}

function dispatch(e: KeyboardEvent) {
  const pressed = keyToString(e);
  if (!pressed) return;
  const resolved = resolveScope(document.activeElement);
  // Snapshot the map values before iterating — a handler may register
  // or unregister shortcuts (e.g. closing a modal unmounts its entry).
  const entries = Array.from(registry.values());
  for (const entry of entries) {
    if (entry.keys !== pressed) continue;
    if (!scopeMatches(entry.scope, resolved)) continue;
    if (entry.when && !entry.when()) continue;
    if (entry.preventDefault !== false) e.preventDefault();
    entry.handler(e);
  }
}

function ensureListener() {
  if (listenerAttached) return;
  window.addEventListener('keydown', dispatch);
  listenerAttached = true;
}

function maybeDetachListener() {
  if (!listenerAttached) return;
  if (registry.size > 0) return;
  window.removeEventListener('keydown', dispatch);
  listenerAttached = false;
}

export function registerShortcut(entry: ShortcutEntry): () => void {
  // Re-registering the same id (e.g. when a React effect re-runs)
  // overwrites the previous entry rather than stacking — last write
  // wins for a given id. Unregistration is keyed by id too, so the
  // returned cleanup is safe even after an overwrite.
  registry.set(entry.id, entry);
  ensureListener();
  return () => {
    // Only delete if the slot still holds *this* entry. Prevents an
    // older cleanup (from a stale closure) from clobbering a newer
    // registration that replaced it.
    const current = registry.get(entry.id);
    if (current === entry) registry.delete(entry.id);
    maybeDetachListener();
  };
}

export function listShortcuts(): ShortcutEntry[] {
  return Array.from(registry.values());
}

export function useShortcut(entry: ShortcutEntry, deps?: DependencyList): void {
  // We intentionally omit `entry` from the dependency array — callers
  // pass an object literal each render, which would re-register on
  // every render without `deps` discipline. The `deps` argument is the
  // contract: pass whatever the handler closes over.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => registerShortcut(entry), deps ?? []);
}
