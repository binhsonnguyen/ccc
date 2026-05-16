// Module-scope single-instance menu controller. Components subscribe to
// changes; opening menu B closes menu A. Lives outside React tree so any
// component can call openMenu/closeMenu without prop drilling.

type Listener = (openId: string | null) => void;

let currentId: string | null = null;
const listeners = new Set<Listener>();

export function subscribeMenu(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function openMenu(id: string): void {
  if (currentId === id) return;
  currentId = id;
  listeners.forEach((fn) => fn(currentId));
}

export function closeMenu(id?: string): void {
  if (id !== undefined && currentId !== id) return;
  if (currentId === null) return;
  currentId = null;
  listeners.forEach((fn) => fn(currentId));
}

export function getOpenMenu(): string | null {
  return currentId;
}
