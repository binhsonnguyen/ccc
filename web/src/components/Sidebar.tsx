import { useCallback, useEffect, useRef, useState } from 'react';
import SessionRowMenu, { type MenuItem } from './SessionRowMenu';
import NewSessionForm from './NewSessionForm';
import SessionPreview from './SessionPreview';
import Sparkline from './Sparkline';
import {
  ApiError,
  archiveSession,
  fetchActivity,
  fetchSessionTail,
  renameSession,
  removeSession,
  searchSessions,
  type SearchMatch,
} from '../lib/api';
import { useShortcut } from '../lib/shortcuts';
import { cwdMonogram, cwdTint, cwdTintFg } from '../lib/cwdTint';
import { useSidebarLayout, type SidebarGroup } from '../lib/sidebarLayout';
import type { C3Entry, Tab } from '../types';

export type SidebarView = 'active' | 'archived';

interface Props {
  // null = initial load in flight (Sidebar renders skeleton). [] = loaded
  // but empty. Array = loaded with entries.
  sessions: C3Entry[] | null;
  // c3Id of the focused pane in the active tab. Drives row "active"
  // highlight + ARIA aria-current.
  activeC3Id: string | null;
  openTabs: Tab[];
  view: SidebarView;
  onViewChange: (v: SidebarView) => void;
  onOpen: (entry: C3Entry) => void;
  onRefresh: () => void;
  onSessionSelected?: () => void;
  // After mutating operations we ask App to refresh the list and maybe
  // close a tab (remove path closes the open tab if it matched the
  // removed entry).
  onAfterMutate: () => void;
  // Close any open pane bound to the given c3Id (used by row removal).
  onCloseTabFor: (c3Id: string) => void;
  // Drawer mode flag for the new-session form fallback.
  narrow: boolean;
  showToast: (
    msg: string,
    opts?: { variant?: 'info' | 'error' | 'warning' | 'success' },
  ) => void;
  // Counter from App: each increment is a request from Welcome (or any
  // other component) to open the inline new-session form. Effect below
  // watches it via dependency array.
  openNewSessionTick?: number;
  // Inline first-prompt flow (2026-05-19): the "+ New session" button
  // now routes to App's main-pane NewSessionPane instead of toggling
  // a sidebar inline form. The Bind dialog still uses the local form
  // (mounted via the openNewSessionTick path) because it's the only
  // remaining caller of the new/bind two-tab UI here.
  onRequestCreate?: () => void;
  // Close the main-pane NewSessionPane if it's open. Called when the user
  // clicks Shell/Bind icons so they don't end up with two new-tab UIs
  // visible (NewSessionPane in main + inline form in sidebar). Symmetric
  // with the Claude icon's own setCreating(false).
  onCloseMainPane?: () => void;
  // B-3: width control. App owns the value (persists to localStorage),
  // Sidebar owns the drag interaction.
  width: number;
  onWidthChange: (w: number) => void;
  // Drawer mode hides the handle (sidebar is fixed-position 280px).
  resizable: boolean;
  // c3Ids of panes that emitted a BEL while not visible. Cleared by App
  // when the owning tab is activated.
  bellSet?: Set<string>;
  // c3Id → exitCode for panes that have exited and are still open.
  exitMap?: Map<string, number>;
  // App reports each session it just created (Claude main-pane flow + split)
  // so the sidebar can drop the new session into the same group as the
  // session that was active when creation started (originC3Id). A fresh
  // object on every create — the effect keys off identity. Sidebar-initiated
  // shell/bind creations are placed directly in their onCreated and don't go
  // through this prop.
  lastCreated?: { id: string; originC3Id: string | null } | null;
  // Palette "Groups" entry asks the sidebar to reveal a group: expand it if
  // collapsed and scroll its header into view. Nonce distinguishes repeats.
  revealGroup?: { id: string; n: number } | null;
}

const SIDEBAR_W_MIN = 200;
const SIDEBAR_W_MAX = 480;
const SIDEBAR_W_DEFAULT = 280;
const clampWidth = (w: number) =>
  Math.max(SIDEBAR_W_MIN, Math.min(SIDEBAR_W_MAX, Math.round(w)));

interface MenuState {
  rowId: string;
  x: number;
  y: number;
}

interface PreviewState {
  rowId: string;
  rect: DOMRect;
  text: string | null; // null = loading
}

// Words a session contributes to the filter haystack (in addition to
// name/cwd). Single switch arm per kind so adding `file-nav` / `ssh`
// later means one line here, not a manual edit at every callsite.
function kindKeyword(s: C3Entry): string {
  switch (s.kind) {
    case 'shell': return 'shell sh';
    default:      return 'claude';
  }
}

// Module-level cache so hover → leave → hover doesn't re-fetch within
// 5 s. Keyed by c3 id; value is the raw text body the server returned
// (still containing ANSI — stripping happens in the component).
const TAIL_TTL_MS = 5000;
const tailCache = new Map<string, { text: string; at: number }>();
function getCachedTail(id: string): string | null {
  const hit = tailCache.get(id);
  if (!hit) return null;
  if (Date.now() - hit.at > TAIL_TTL_MS) {
    tailCache.delete(id);
    return null;
  }
  return hit.text;
}
function setCachedTail(id: string, text: string) {
  tailCache.set(id, { text, at: Date.now() });
}

const HOVER_DELAY_MS = 600;
const DISMISS_DELAY_MS = 200;

// C-1: per-row activity cache. Same idea as the tail cache but with a
// shorter TTL (1.5 s) — the sparkline polls every 2 s so a single
// in-flight result should not be re-fetched by a sibling re-render
// in the meantime. Polling itself is gated by document visibility +
// a 30-row cap so a giant sidebar doesn't hammer the server.
interface ActivityCacheEntry {
  buckets: number[] | null;
  at: number;
}
const ACTIVITY_POLL_MS = 2000;
// TTL slightly under the poll period so a tick that runs a hair late
// still hits the cache, but every poll *does* re-fetch (otherwise
// what's the point of polling). Used by sibling renders within the
// same window too.
const ACTIVITY_TTL_MS = ACTIVITY_POLL_MS - 100;
const ACTIVITY_MAX_ROWS = 30;
const activityCache = new Map<string, ActivityCacheEntry>();
function getCachedActivity(id: string): number[] | null | undefined {
  const hit = activityCache.get(id);
  if (!hit) return undefined;
  if (Date.now() - hit.at > ACTIVITY_TTL_MS) return undefined;
  return hit.buckets;
}
function setCachedActivity(id: string, buckets: number[] | null) {
  activityCache.set(id, { buckets, at: Date.now() });
}

// Cheap structural compare for two bucket arrays (or nulls). Returns
// true when the sparkline would render identically — used to skip
// React state updates that would otherwise rerender 30 rows on every
// poll even when nothing changed.
function buckets_eq(
  a: number[] | null | undefined,
  b: number[] | null | undefined,
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// ---- Phase 2: render item types -----------------------------------------

type RenderItem =
  | { type: 'session'; session: C3Entry; inGroup: false }
  | { type: 'session'; session: C3Entry; inGroup: true; groupId: string }
  | { type: 'group'; group: SidebarGroup; members: C3Entry[] }
  | { type: 'group-empty'; groupId: string };

// Build the mixed render list from layout + sessions.
// 1. Walk layout.order: plain c3Id → ungrouped session, "grp:…" → group block.
// 2. Append sessions not in any group and not in top-level order.
function buildRenderItems(
  layout: { order: string[]; groups: SidebarGroup[] },
  sessions: C3Entry[],
): RenderItem[] {
  const byId = new Map(sessions.map((s) => [s.id, s]));
  const groupById = new Map(layout.groups.map((g) => [g.id, g]));

  // Set of all c3Ids inside any group.
  const inAnyGroup = new Set<string>();
  for (const g of layout.groups) {
    for (const id of g.memberOrder) inAnyGroup.add(id);
  }

  const result: RenderItem[] = [];
  const placed = new Set<string>(); // c3Ids placed (either ungrouped or in group)
  const emittedGroups = new Set<string>(); // group ids already pushed

  const pushGroup = (g: SidebarGroup) => {
    const members: C3Entry[] = [];
    for (const mid of g.memberOrder) {
      const s = byId.get(mid);
      if (s) {
        members.push(s);
        placed.add(mid);
      }
    }
    result.push({ type: 'group', group: g, members });
    emittedGroups.add(g.id);
  };

  for (const slot of layout.order) {
    if (slot.startsWith('grp:')) {
      const groupId = slot.slice(4);
      const g = groupById.get(groupId);
      if (!g) continue;
      pushGroup(g);
    } else {
      const s = byId.get(slot);
      if (s && !inAnyGroup.has(slot)) {
        result.push({ type: 'session', session: s, inGroup: false });
        placed.add(slot);
      }
    }
  }

  // Defensive: emit any group that exists in `groups` but whose "grp:" slot is
  // missing from `order` (orphan). normalizeLayout repairs this on load/save,
  // but rendering them anyway means a stale/cross-tab layout never hides a
  // group + its sessions. Appended in groups-array order, after ordered slots.
  for (const g of layout.groups) {
    if (!emittedGroups.has(g.id)) pushGroup(g);
  }

  // Append ungrouped sessions not yet placed (new sessions, not in order).
  for (const s of sessions) {
    if (!placed.has(s.id) && !inAnyGroup.has(s.id)) {
      result.push({ type: 'session', session: s, inGroup: false });
    }
  }

  // Expand group member items for groups that are not collapsed.
  const final: RenderItem[] = [];
  for (const item of result) {
    if (item.type === 'group') {
      final.push(item);
      if (!item.group.collapsed) {
        if (item.members.length === 0) {
          // Expanded but empty group: emit a placeholder row so the block
          // isn't a bare header (looks broken) and gives drag a drop target.
          final.push({ type: 'group-empty', groupId: item.group.id });
        } else {
          for (const s of item.members) {
            final.push({ type: 'session', session: s, inGroup: true, groupId: item.group.id });
          }
        }
      }
    } else {
      final.push(item);
    }
  }

  return final;
}

// Canonical top-level sequence from render items: ungrouped c3Ids and
// "grp:<id>" slots in display order (includes appended new sessions). Used to
// rebuild layout.order on reorder/drag without dropping group slots — the old
// per-scope rebuild lost them, making groups vanish.
function buildTopSeq(items: RenderItem[]): string[] {
  const seq: string[] = [];
  for (const item of items) {
    if (item.type === 'group') seq.push('grp:' + item.group.id);
    else if (item.type === 'session' && !item.inGroup) seq.push(item.session.id);
  }
  return seq;
}

// Generate a unique group ID (without the "grp:" prefix; caller adds it).
function newGroupRawId(): string {
  return Math.random().toString(36).slice(2, 10);
}

// Rollup status for a collapsed group header. Mirrors the per-row priority
// (attention > exit > running > pending) but aggregated over members: the
// header shows the single highest-priority signal present among them, so a
// collapsed group isn't a status blind spot. Only `attn` can short-circuit —
// it's the top tier, so a bell on any member wins regardless of the others;
// every lower tier must scan all members first (a later member could still
// hold a higher signal). 'open' is intentionally omitted — "open in a tab" is
// a per-row UI fact, not a member-health signal worth surfacing on the header.
type GroupRollup = 'attn' | 'exit-err' | 'exit-ok' | 'warm' | 'pending' | null;

function groupStatusRollup(
  members: C3Entry[],
  bellSet: Set<string> | undefined,
  exitMap: Map<string, number> | undefined,
): GroupRollup {
  let attn = false;
  let exitErr = false;
  let exitOk = false;
  let warm = false;
  let pending = false;
  for (const s of members) {
    if (bellSet?.has(s.id)) attn = true;
    const code = exitMap?.get(s.id);
    if (code !== undefined) {
      if (code !== 0) exitErr = true;
      else exitOk = true;
    }
    // Same pending test as renderSessionRow: shell tabs are never pending.
    const isPending = !s.claudeUuid && s.kind !== 'shell';
    if (s.live && !isPending) warm = true;
    if (isPending) pending = true;
  }
  if (attn) return 'attn';
  if (exitErr) return 'exit-err';
  if (exitOk) return 'exit-ok';
  if (warm) return 'warm';
  if (pending) return 'pending';
  return null;
}

export default function Sidebar({
  sessions,
  activeC3Id,
  openTabs,
  view,
  onViewChange,
  onOpen,
  onRefresh,
  onSessionSelected,
  onAfterMutate,
  onCloseTabFor,
  narrow,
  showToast,
  openNewSessionTick,
  onRequestCreate,
  onCloseMainPane,
  width,
  onWidthChange,
  resizable,
  bellSet,
  exitMap,
  lastCreated,
  revealGroup,
}: Props) {
  // Resize drag state. We don't put `dragging` in React state (would
  // rerender on every mouse move); we mark the DOM with a class for the
  // visual feedback instead.
  const dragStartRef = useRef<{ x: number; w: number } | null>(null);
  const resizerRef = useRef<HTMLDivElement | null>(null);

  // Sidebar layout (order, groups). Persisted to localStorage.
  const [layout, setLayout] = useSidebarLayout();
  // Mirror of the latest layout for use inside async callbacks (doRemove)
  // whose closures would otherwise capture a stale `layout` after an await.
  const layoutRef = useRef(layout);
  layoutRef.current = layout;

  // Small counter used only to force a re-render after drag commit/cancel
  // without putting drag state in React state (avoids mousemove thrash).
  const [dragVersion, setDragVersion] = useState(0);

  // Drag state for row reorder — stored in a ref so mousemove doesn't
  // trigger React re-renders. The indicator + ghost are DOM nodes managed
  // imperatively. dragVersion bumps to trigger repaint on commit/cancel.
  // groupId: null = ungrouped row drag, string = within-group drag,
  // '__group__' = dragging a group header.
  type DragState = {
    draggingId: string;
    groupId: string | null; // SOURCE scope: null=ungrouped, '__group__'=group drag, else within-group
    // DESTINATION scope, resolved live each mousemove (row drags only; the
    // '__group__' header-reorder path ignores it). null=ungrouped top level,
    // string=that group id.
    dstGroupId: string | null;
    // Header/placeholder element currently highlighted as the drop target
    // (when dropping onto a collapsed or empty group). Cleared on move/commit.
    dropTargetEl: HTMLElement | null;
    ghostEl: HTMLDivElement;
    sourceIdx: number;
    dropIdx: number;
    indicatorEl: HTMLDivElement;
    offsetX: number;
    offsetY: number;
    onMove: (e: MouseEvent) => void;
    onUp: () => void;
    onKey: (e: KeyboardEvent) => void;
  };
  const rowDragRef = useRef<DragState | null>(null);
  // Ref to the <ul> list so we can place the indicator inside it.
  const sessionListRef = useRef<HTMLUListElement | null>(null);

  // ---- Phase 2 state ------------------------------------------------------

  // Group rename
  const [renamingGroupId, setRenamingGroupId] = useState<string | null>(null);
  const [renameGroupDraft, setRenameGroupDraft] = useState('');

  // Armed group delete (two-click confirm)
  const [armedGroupId, setArmedGroupId] = useState<string | null>(null);
  const armedTimerRef = useRef<number | null>(null);

  // Move-to-group popover
  interface MoveGroupPopover {
    sessionId: string;
    x: number;
    y: number;
  }
  const [moveGroupPopover, setMoveGroupPopover] = useState<MoveGroupPopover | null>(null);

  // ---- Phase 2: group helpers ---------------------------------------------

  const findGroupOf = useCallback(
    (c3Id: string): SidebarGroup | null => {
      return layout.groups.find((g) => g.memberOrder.includes(c3Id)) ?? null;
    },
    [layout],
  );

  const moveToGroup = useCallback(
    (c3Id: string, groupId: string) => {
      const newLayout = { ...layout };
      // Remove from top-level order if present.
      newLayout.order = newLayout.order.filter((id) => id !== c3Id);
      // Remove from any existing group.
      newLayout.groups = newLayout.groups.map((g) => ({
        ...g,
        memberOrder: g.memberOrder.filter((id) => id !== c3Id),
      }));
      // Add to target group.
      newLayout.groups = newLayout.groups.map((g) =>
        g.id === groupId
          ? { ...g, memberOrder: [...g.memberOrder, c3Id] }
          : g,
      );
      setLayout(newLayout);
    },
    [layout, setLayout],
  );

  const removeFromGroup = useCallback(
    (c3Id: string) => {
      const newLayout = { ...layout };
      // Remove from all groups.
      newLayout.groups = newLayout.groups.map((g) => ({
        ...g,
        memberOrder: g.memberOrder.filter((id) => id !== c3Id),
      }));
      // Append to end of top-level order (if not already there).
      if (!newLayout.order.includes(c3Id)) {
        newLayout.order = [...newLayout.order, c3Id];
      }
      setLayout(newLayout);
    },
    [layout, setLayout],
  );

  // Drop a permanently-removed session from the layout: prune it from the
  // top-level order and from every group's memberOrder. Called only on real
  // delete (removeSession) — NOT on archive, where membership is preserved so
  // unarchive restores the session to its group. Empty groups are kept: an
  // empty group is a valid, intentional state (createGroup allows it, and the
  // group-empty placeholder gives it a drop target). Reads layoutRef so it's
  // correct when invoked after an await in doRemove.
  const forgetSession = useCallback(
    (c3Id: string) => {
      const cur = layoutRef.current;
      const inOrder = cur.order.includes(c3Id);
      const inGroup = cur.groups.some((g) => g.memberOrder.includes(c3Id));
      if (!inOrder && !inGroup) return; // nothing to prune — skip the write
      setLayout({
        ...cur,
        order: cur.order.filter((s) => s !== c3Id),
        groups: cur.groups.map((g) => ({
          ...g,
          memberOrder: g.memberOrder.filter((id) => id !== c3Id),
        })),
      });
    },
    [setLayout],
  );

  // Place a freshly-created session into the group of the session that was
  // active when creation started (originC3Id), so "new session while working
  // in a group" lands in that group instead of ungrouped. No-op when the
  // origin is ungrouped/unknown, or when the new session is somehow already
  // grouped (don't override an explicit placement). Reads layoutRef so it's
  // correct from an effect that may fire a tick after the create resolves.
  const placeNewSession = useCallback(
    (newId: string, originC3Id: string | null) => {
      if (!originC3Id || newId === originC3Id) return;
      const cur = layoutRef.current;
      const target = cur.groups.find((g) => g.memberOrder.includes(originC3Id));
      if (!target) return; // origin is ungrouped — leave new session ungrouped
      if (cur.groups.some((g) => g.memberOrder.includes(newId))) return; // already placed
      setLayout({
        ...cur,
        order: cur.order.filter((s) => s !== newId),
        groups: cur.groups.map((g) =>
          g.id === target.id
            ? { ...g, memberOrder: [...g.memberOrder, newId] }
            : g,
        ),
      });
    },
    [setLayout],
  );

  const createGroup = useCallback(
    (name: string, c3IdToAdd?: string) => {
      const rawId = newGroupRawId();
      const fullSlot = 'grp:' + rawId;
      const newGroup: SidebarGroup = {
        id: rawId,
        name,
        collapsed: false,
        memberOrder: c3IdToAdd ? [c3IdToAdd] : [],
      };
      const newLayout = { ...layout };
      // Remove session from top-level order and other groups if needed.
      if (c3IdToAdd) {
        newLayout.order = newLayout.order.filter((x) => x !== c3IdToAdd);
        newLayout.groups = newLayout.groups.map((g) => ({
          ...g,
          memberOrder: g.memberOrder.filter((id2) => id2 !== c3IdToAdd),
        }));
      }
      newLayout.groups = [...newLayout.groups, newGroup];
      newLayout.order = [...newLayout.order, fullSlot];
      setLayout(newLayout);
      return rawId;
    },
    [layout, setLayout],
  );

  const toggleCollapse = useCallback(
    (groupId: string) => {
      setLayout({
        ...layout,
        groups: layout.groups.map((g) =>
          g.id === groupId ? { ...g, collapsed: !g.collapsed } : g,
        ),
      });
    },
    [layout, setLayout],
  );

  const deleteGroup = useCallback(
    (groupId: string) => {
      const g = layout.groups.find((x) => x.id === groupId);
      if (!g) return;
      const newLayout = { ...layout };
      // Remove group from groups list.
      newLayout.groups = newLayout.groups.filter((x) => x.id !== groupId);
      // Remove group slot from order.
      newLayout.order = newLayout.order.filter((x) => x !== 'grp:' + groupId);
      // Members fall back to ungrouped — append at end (without duplicating).
      const toAppend = g.memberOrder.filter((id) => !newLayout.order.includes(id));
      newLayout.order = [...newLayout.order, ...toAppend];
      setLayout(newLayout);
    },
    [layout, setLayout],
  );

  // Auto-increment group name: "Group 1", "Group 2", …
  const nextGroupName = useCallback(() => {
    const existing = layout.groups.map((g) => g.name);
    let n = 1;
    while (existing.includes(`Group ${n}`)) n++;
    return `Group ${n}`;
  }, [layout]);

  // Create an empty top-level group (no session needed) and drop straight
  // into inline-rename so the user can name it. createGroup returns the new
  // id; we set rename state directly rather than via startGroupRename, which
  // reads the stale pre-update layout.
  const createGroupAndRename = useCallback(() => {
    const name = nextGroupName();
    const rawId = createGroup(name);
    setRenamingGroupId(rawId);
    setRenameGroupDraft(name);
  }, [createGroup, nextGroupName]);

  // Arm delete: first click arms, second click confirms.
  const triggerGroupDelete = useCallback(
    (groupId: string) => {
      if (armedGroupId === groupId) {
        // Second click: confirm delete.
        if (armedTimerRef.current !== null) {
          window.clearTimeout(armedTimerRef.current);
          armedTimerRef.current = null;
        }
        setArmedGroupId(null);
        deleteGroup(groupId);
      } else {
        // First click: arm.
        if (armedTimerRef.current !== null) {
          window.clearTimeout(armedTimerRef.current);
        }
        setArmedGroupId(groupId);
        armedTimerRef.current = window.setTimeout(() => {
          setArmedGroupId(null);
          armedTimerRef.current = null;
        }, 2000);
      }
    },
    [armedGroupId, deleteGroup],
  );

  // Cleanup arm timer on unmount.
  useEffect(() => {
    return () => {
      if (armedTimerRef.current !== null) window.clearTimeout(armedTimerRef.current);
    };
  }, []);

  const startGroupRename = useCallback(
    (groupId: string) => {
      const g = layout.groups.find((x) => x.id === groupId);
      if (!g) return;
      setRenamingGroupId(groupId);
      setRenameGroupDraft(g.name);
    },
    [layout],
  );

  const commitGroupRename = useCallback(() => {
    const name = renameGroupDraft.trim();
    setRenamingGroupId(null);
    if (!name || !renamingGroupId) return;
    const gid = renamingGroupId;
    setLayout({
      ...layout,
      groups: layout.groups.map((g) =>
        g.id === gid ? { ...g, name } : g,
      ),
    });
  }, [layout, renamingGroupId, renameGroupDraft, setLayout]);

  const onResizerMouseDown = (e: React.MouseEvent) => {
    if (!resizable) return;
    e.preventDefault();
    dragStartRef.current = { x: e.clientX, w: width };
    resizerRef.current?.classList.add('dragging');
    document.body.style.cursor = 'col-resize';
    // Prevent text-selection flicker during drag.
    document.body.style.userSelect = 'none';
    const onMove = (ev: MouseEvent) => {
      const start = dragStartRef.current;
      if (!start) return;
      const next = clampWidth(start.w + (ev.clientX - start.x));
      onWidthChange(next);
    };
    const onUp = () => {
      dragStartRef.current = null;
      resizerRef.current?.classList.remove('dragging');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };
  const onResizerDblClick = () => {
    if (!resizable) return;
    onWidthChange(SIDEBAR_W_DEFAULT);
  };
  const onResizerKeyDown = (e: React.KeyboardEvent) => {
    if (!resizable) return;
    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      onWidthChange(clampWidth(width - 10));
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      onWidthChange(clampWidth(width + 10));
    } else if (e.key === 'Home') {
      e.preventDefault();
      onWidthChange(SIDEBAR_W_MIN);
    } else if (e.key === 'End') {
      e.preventDefault();
      onWidthChange(SIDEBAR_W_MAX);
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onWidthChange(SIDEBAR_W_DEFAULT);
    }
  };
  // Open set is keyed by c3Id (each pane's session). For the "already
  // open in tab N" tooltip we also track which tab index a c3Id is in.
  const openByC3 = new Map<string, number>();
  openTabs.forEach((t, ti) => {
    for (const p of t.panes) {
      if (!openByC3.has(p.c3Id)) openByC3.set(p.c3Id, ti);
    }
  });
  const openSet = new Set(openByC3.keys());
  const [menu, setMenu] = useState<MenuState | null>(null);
  // Filter (B-2). Local + transient: not persisted across reloads — the
  // sidebar's job is to surface sessions, not remember a search.
  const [filter, setFilter] = useState('');
  const filterInputRef = useRef<HTMLInputElement | null>(null);
  // Deep search (full-text JSONL grep). State machine:
  //   idle       — q<3 chars, or no deep-search requested
  //   loading    — request in flight
  //   results    — array (possibly empty)
  //   error      — fetch failed
  // `searchForced` is set true when the user clicks "Search messages…"
  // so we run the query even when there ARE name matches.
  const [searchState, setSearchState] = useState<
    | { kind: 'idle' }
    | { kind: 'loading' }
    | { kind: 'results'; matches: SearchMatch[]; truncated: boolean; q: string }
    | { kind: 'error'; message: string }
  >({ kind: 'idle' });
  const [searchForced, setSearchForced] = useState(false);
  // Token guards against stale responses: incremented on every new query,
  // each fetch captures its token and discards itself if outdated.
  const searchTokenRef = useRef(0);
  const searchAbortRef = useRef<AbortController | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  // Set transiently when Esc dismisses the rename input; blur fires after
  // unmount and would otherwise commit the draft (PATCH). Read+reset in
  // commitRename. ref (not state) because commitRename is called in the
  // same tick as the unmount/blur sequence.
  const renameCancelledRef = useRef(false);
  // Set to true in startRename so closeMenuLocal's setTimeout skips focus
  // restoration (which would steal focus from the autoFocus'd input, trigger
  // onBlur → commitRename, and immediately dismiss the input).
  const renameStartingRef = useRef(false);
  const [renameDraft, setRenameDraft] = useState('');
  const [creating, setCreating] = useState(false);
  // When the inline form opens for the Bind flow, force its mode to
  // 'bind' so the user lands directly on the existing-uuid picker.
  // (New-session creation moved to the main pane.) NewSessionForm
  // reads this via initialMode and defaults to 'new' when unset.
  const [creatingMode, setCreatingMode] = useState<'new' | 'shell' | 'bind'>('new');
  // Bumped when the user clicks a sidebar icon whose form is already
  // open. NewSessionForm uses it as a key on a one-shot pulse overlay
  // (mirrors the App-level paneFlashKey for the Claude/main-pane case).
  const [inlineFlashKey, setInlineFlashKey] = useState(0);
  // Effect-driven: Welcome's "New" card increments the tick and we
  // open the form. Skip the initial mount (tick=0 baseline) so this
  // doesn't pop the form open on first render.
  const firstTickRef = useRef(true);
  useEffect(() => {
    if (firstTickRef.current) {
      firstTickRef.current = false;
      return;
    }
    // Suppressed when onRequestCreate is wired: App handles the new-
    // session request itself via the main-pane NewSessionPane and the
    // sidebar inline form is reserved for Bind. Without this guard,
    // every Welcome / palette "New session" trigger would open BOTH
    // the main pane and the legacy sidebar form.
    if (onRequestCreate) return;
    if (openNewSessionTick !== undefined) setCreating(true);
  }, [openNewSessionTick, onRequestCreate]);

  // App-driven session creations (Claude main-pane flow + split) inherit the
  // active session's group. lastCreated is a fresh object per create, so this
  // fires once each. Sidebar-initiated shell/bind creations place directly in
  // their onCreated and never set this prop.
  useEffect(() => {
    if (lastCreated) placeNewSession(lastCreated.id, lastCreated.originC3Id);
  }, [lastCreated, placeNewSession]);

  // Reveal a group on request from the palette: expand it (if collapsed) then
  // scroll its header into view. Expand and scroll are split across a frame so
  // the (possibly newly-expanded) header exists in the DOM before we scroll.
  useEffect(() => {
    if (!revealGroup) return;
    const gid = revealGroup.id;
    const cur = layoutRef.current;
    const g = cur.groups.find((x) => x.id === gid);
    if (!g) return;
    // Clear any active text filter first: filtered mode renders a flat list
    // with no group headers, so the scroll/focus target below wouldn't exist.
    setFilter('');
    if (g.collapsed) {
      setLayout({
        ...cur,
        groups: cur.groups.map((x) =>
          x.id === gid ? { ...x, collapsed: false } : x,
        ),
      });
    }
    requestAnimationFrame(() => {
      const el = sessionListRef.current?.querySelector<HTMLElement>(
        `li.session-group-header[data-group-id="${gid}"]`,
      );
      el?.scrollIntoView({ block: 'nearest' });
      el?.focus?.();
    });
  }, [revealGroup, setLayout, setFilter]);
  const rowRefs = useRef<Map<string, HTMLLIElement | null>>(new Map());

  // C-2 hover preview state. Two timers: hoverTimer fires the fetch
  // after 600 ms of dwell; dismissTimer gives the user a 200 ms grace
  // to slide the cursor from row → preview without flicker. We store
  // both as refs since they don't drive render.
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const hoverTimer = useRef<number | null>(null);
  const dismissTimer = useRef<number | null>(null);
  // Generation counter so a fetch that started for row A but resolved
  // after the user moved to row B doesn't overwrite B's preview.
  const previewGen = useRef(0);

  const clearHoverTimer = () => {
    if (hoverTimer.current !== null) {
      window.clearTimeout(hoverTimer.current);
      hoverTimer.current = null;
    }
  };
  const clearDismissTimer = () => {
    if (dismissTimer.current !== null) {
      window.clearTimeout(dismissTimer.current);
      dismissTimer.current = null;
    }
  };
  const closePreview = useCallback(() => {
    clearHoverTimer();
    clearDismissTimer();
    previewGen.current++;
    setPreview(null);
  }, []);

  // Show preview for a session row. Disabled for pending/non-live
  // entries — the server would 204 anyway, but skipping the fetch
  // keeps round-trips off the network.
  const openPreviewFor = useCallback((s: C3Entry, el: HTMLElement) => {
    if (!s.claudeUuid || !s.live) return;
    const rect = el.getBoundingClientRect();
    const cached = getCachedTail(s.id);
    const gen = ++previewGen.current;
    setPreview({ rowId: s.id, rect, text: cached });
    if (cached !== null) return;
    fetchSessionTail(s.id, 2048)
      .then((text) => {
        setCachedTail(s.id, text);
        // Stale fetch: user moved to another row already.
        if (previewGen.current !== gen) return;
        setPreview((p) => (p && p.rowId === s.id ? { ...p, text } : p));
      })
      .catch(() => {
        if (previewGen.current !== gen) return;
        // Render as empty rather than surfacing an error toast for a
        // decorative tooltip.
        setPreview((p) => (p && p.rowId === s.id ? { ...p, text: '' } : p));
      });
  }, []);

  const onRowMouseEnter = useCallback(
    (s: C3Entry, el: HTMLElement) => {
      // Disable preview during rename / for pending rows.
      if (renamingId === s.id || !s.claudeUuid || !s.live) return;
      clearDismissTimer();
      clearHoverTimer();
      hoverTimer.current = window.setTimeout(() => {
        hoverTimer.current = null;
        openPreviewFor(s, el);
      }, HOVER_DELAY_MS);
    },
    [openPreviewFor, renamingId],
  );
  const onRowMouseLeave = useCallback(() => {
    clearHoverTimer();
    clearDismissTimer();
    dismissTimer.current = window.setTimeout(() => {
      dismissTimer.current = null;
      previewGen.current++;
      setPreview(null);
    }, DISMISS_DELAY_MS);
  }, []);
  const onPreviewMouseEnter = useCallback(() => {
    clearDismissTimer();
  }, []);
  // Unmount cleanup.
  useEffect(
    () => () => {
      clearHoverTimer();
      clearDismissTimer();
    },
    [],
  );

  // C-1: activity polling for the sparkline. We keep a per-row map of
  // buckets in state so canvases re-render only when their data
  // changes. The poll loop runs every 2 s, skips when the tab is
  // hidden, and only requests at most ACTIVITY_MAX_ROWS live rows so a
  // very long sidebar doesn't generate dozens of round-trips. Pending
  // and non-live entries are skipped entirely — server would 204 anyway.
  const [activity, setActivity] = useState<Map<string, number[] | null>>(
    () => new Map(),
  );
  useEffect(() => {
    if (!sessions || sessions.length === 0) return;
    let cancelled = false;
    const tick = async () => {
      if (document.hidden) return;
      const live = sessions
        .filter((s) => s.live && !!s.claudeUuid)
        .slice(0, ACTIVITY_MAX_ROWS);
      if (live.length === 0) return;
      const results = await Promise.all(
        live.map(async (s) => {
          const cached = getCachedActivity(s.id);
          if (cached !== undefined) return [s.id, cached] as const;
          try {
            // fetchActivity now returns {buckets, idleMs}; sparkline
            // only needs buckets. The idleMs companion is consumed by
            // TerminalPane via its own poll (independent cadence).
            const r = await fetchActivity(s.id);
            const b = r ? r.buckets : null;
            setCachedActivity(s.id, b);
            return [s.id, b] as const;
          } catch {
            return [s.id, null] as const;
          }
        }),
      );
      if (cancelled) return;
      setActivity((prev) => {
        // Only allocate a new Map if at least one entry actually
        // changed — reduces React rerender churn when the server
        // returns the same buckets two polls in a row.
        let changed = false;
        const next = new Map(prev);
        for (const [id, b] of results) {
          const cur = prev.get(id);
          if (!buckets_eq(cur, b)) {
            next.set(id, b);
            changed = true;
          }
        }
        return changed ? next : prev;
      });
    };
    void tick();
    const interval = window.setInterval(() => void tick(), ACTIVITY_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [sessions]);

  const closeMenuLocal = useCallback(() => {
    const rowId = menu?.rowId;
    setMenu(null);
    if (rowId) {
      window.setTimeout(() => {
        if (renameStartingRef.current) {
          renameStartingRef.current = false;
          return;
        }
        const el = rowRefs.current.get(rowId);
        el?.focus?.();
      }, 0);
    }
  }, [menu]);

  // --- mutation helpers ---------------------------------------------------

  const doArchive = useCallback(
    async (s: C3Entry) => {
      try {
        const r = await archiveSession(s.id);
        showToast(r.archived ? `Archived ${s.name || s.id}` : `Unarchived ${s.name || s.id}`, {
          variant: 'info',
        });
        onAfterMutate();
      } catch (err) {
        const msg = err instanceof ApiError ? err.body : 'Archive failed';
        showToast(msg, { variant: 'error' });
      }
    },
    [onAfterMutate, showToast],
  );

  const doRemove = useCallback(
    async (s: C3Entry) => {
      const wasLive = !!s.live;
      try {
        await removeSession(s.id, wasLive);
        showToast(`Removed ${s.name || s.id}`, { variant: 'info' });
        // Close any open pane attached to this session's c3Id.
        onCloseTabFor(s.id);
        // Prune the gone session from the sidebar layout (order + groups).
        forgetSession(s.id);
        onAfterMutate();
      } catch (err) {
        if (err instanceof ApiError && err.status === 409) {
          // Defensive: server returned 409 even though we didn't think
          // entry was live. Retry once with force=1.
          try {
            await removeSession(s.id, true);
            showToast(`Removed ${s.name || s.id} (force)`, { variant: 'warning' });
            // Close any open pane attached to this session's c3Id.
            onCloseTabFor(s.id);
            // Prune the gone session from the sidebar layout (order + groups).
            forgetSession(s.id);
            onAfterMutate();
            return;
          } catch (err2) {
            const msg = err2 instanceof ApiError ? err2.body : 'Remove failed';
            showToast(msg, { variant: 'error' });
            return;
          }
        }
        const msg = err instanceof ApiError ? err.body : 'Remove failed';
        showToast(msg, { variant: 'error' });
      }
    },
    [onAfterMutate, onCloseTabFor, showToast, forgetSession],
  );

  const startRename = useCallback((s: C3Entry) => {
    renameStartingRef.current = true;
    setRenamingId(s.id);
    setRenameDraft(s.name || '');
  }, []);

  const commitRename = useCallback(
    async (s: C3Entry) => {
      const next = renameDraft.trim();
      setRenamingId(null);
      if (renameCancelledRef.current) {
        renameCancelledRef.current = false;
        return;
      }
      if (!next || next === s.name) return;
      try {
        await renameSession(s.id, next);
        showToast(`Renamed to ${next}`, { variant: 'info' });
        onAfterMutate();
      } catch (err) {
        const msg = err instanceof ApiError ? err.body : 'Rename failed';
        showToast(msg, { variant: 'error' });
      }
    },
    [onAfterMutate, renameDraft, showToast],
  );

  // --- menu construction --------------------------------------------------

  const buildMenu = useCallback(
    (s: C3Entry): MenuItem[] => {
      const isOpen = openSet.has(s.id);
      const pending = !s.claudeUuid && s.kind !== 'shell';
      const archived = view === 'archived';
      const currentGroup = findGroupOf(s.id);
      return [
        {
          id: 'open',
          // Pending entries: opening the tab triggers D-7 spawn flow
          // (claude no-resume) so the label reads "Start" to telegraph
          // the side-effect.
          label: pending
            ? 'Start session in tab'
            : isOpen
              ? 'Switch to tab'
              : 'Open in tab',
          onClick: () => {
            onOpen(s);
            onSessionSelected?.();
          },
        },
        {
          id: 'rename',
          label: 'Rename…',
          hint: 'R',
          onClick: () => startRename(s),
        },
        {
          id: 'archive',
          label: archived ? 'Unarchive' : 'Archive',
          hint: 'A',
          onClick: () => void doArchive(s),
        },
        {
          id: 'remove',
          label: s.live ? 'Remove… (PTY live)' : 'Remove…',
          hint: '⌘⌫',
          confirm: true,
          confirmLabel: 'Confirm remove?',
          onClick: () => void doRemove(s),
        },
        { id: 'sep1', label: '', separator: true },
        // Phase 2: group membership
        ...(currentGroup
          ? [{
              id: 'ungroup' as const,
              label: 'Remove from group',
              onClick: () => removeFromGroup(s.id),
            }]
          : [{
              id: 'move-group' as const,
              label: 'Move to group…',
              onClick: (_e?: React.MouseEvent) => {
                const el = rowRefs.current.get(s.id);
                const rect = el?.getBoundingClientRect();
                setMoveGroupPopover({
                  sessionId: s.id,
                  x: rect ? rect.right + 4 : 200,
                  y: rect ? rect.top : 200,
                });
              },
            }]),
        { id: 'sep2', label: '', separator: true },
        // Copy uuid is hidden (not disabled) for shell rows — shell tabs
        // never have a Claude uuid by design, so there's no future state
        // where the item works. Disabled-vs-hide: disable is right for
        // transient "pending" claude rows (will work soon); hide is right
        // for kinds that never qualify.
        ...(s.kind === 'shell'
          ? []
          : [{
              id: 'copy-uuid' as const,
              label: 'Copy uuid',
              disabled: pending,
              onClick: () => {
                if (s.claudeUuid) void navigator.clipboard?.writeText(s.claudeUuid);
              },
            }]),
        {
          id: 'copy-cwd',
          label: 'Copy cwd',
          disabled: !s.cwd,
          onClick: () => {
            if (s.cwd) void navigator.clipboard?.writeText(s.cwd);
          },
        },
      ];
    },
    [
      doArchive,
      doRemove,
      findGroupOf,
      onOpen,
      onSessionSelected,
      openSet,
      removeFromGroup,
      startRename,
      view,
    ],
  );

  // Segmented Active|Archived arrow nav — migrated to the shortcut
  // registry (PLAN.md P-3). Scope 'sidebar-focused' + the `when`
  // predicate keep these entries inert unless the focused element is
  // inside the segmented tablist itself.
  const segWhen = () => {
    const el = document.activeElement;
    return !!el && !!el.closest('.segmented[role="tablist"]');
  };
  const toggleView = () =>
    onViewChange(view === 'active' ? 'archived' : 'active');
  useShortcut(
    {
      id: 'sidebar.segmented.left',
      keys: 'ArrowLeft',
      scope: 'sidebar-focused',
      label: 'Toggle Active / Archived',
      when: segWhen,
      handler: toggleView,
    },
    [view, onViewChange],
  );
  useShortcut(
    {
      id: 'sidebar.segmented.right',
      keys: 'ArrowRight',
      scope: 'sidebar-focused',
      label: 'Toggle Active / Archived',
      when: segWhen,
      handler: toggleView,
    },
    [view, onViewChange],
  );

  // Row-level keys (r / a / Delete / Backspace). Enter stays local on
  // the row (it's button-activation semantics for role="button").
  // The handler reads the focused row's id from data-row-id and looks
  // up the entry by id — the registry is one set per Sidebar instance,
  // not per row.
  const focusedRowEntry = (): C3Entry | null => {
    const el = document.activeElement;
    if (!el) return null;
    const li = el.closest<HTMLElement>('li.session[data-row-id]');
    const rid = li?.dataset.rowId;
    if (!rid) return null;
    return sessions?.find((s) => s.id === rid) ?? null;
  };

  // Group header focused helper.
  const focusedGroupId = (): string | null => {
    const el = document.activeElement;
    if (!el) return null;
    const li = el.closest<HTMLElement>('li.session-group-header[data-group-id]');
    return li?.dataset.groupId ?? null;
  };

  const rowWhen = () => focusedRowEntry() !== null && !renamingId;
  useShortcut(
    {
      id: 'sidebar.row.rename',
      keys: 'r',
      scope: 'sidebar-focused',
      label: 'Rename focused session',
      when: rowWhen,
      handler: () => {
        const s = focusedRowEntry();
        if (s) startRename(s);
      },
    },
    [sessions, renamingId, startRename],
  );
  useShortcut(
    {
      id: 'sidebar.row.archive',
      keys: 'a',
      scope: 'sidebar-focused',
      label: 'Archive / Unarchive focused session',
      when: rowWhen,
      handler: () => {
        const s = focusedRowEntry();
        if (s) void doArchive(s);
      },
    },
    [sessions, renamingId, doArchive],
  );
  // Delete / Backspace open the row menu in danger-armed state — the
  // user picks Remove and confirms there (avoids a parallel confirm UI).
  const openRowMenuAtRow = (s: C3Entry) => {
    const el = rowRefs.current.get(s.id);
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setMenu({ rowId: s.id, x: rect.right - 200, y: rect.bottom });
  };
  useShortcut(
    {
      id: 'sidebar.row.delete',
      keys: 'Delete',
      scope: 'sidebar-focused',
      label: 'Open row actions (delete focus)',
      when: rowWhen,
      handler: () => {
        const s = focusedRowEntry();
        if (s) openRowMenuAtRow(s);
      },
    },
    [sessions, renamingId],
  );
  useShortcut(
    {
      id: 'sidebar.row.backspace',
      keys: 'Backspace',
      scope: 'sidebar-focused',
      label: 'Open row actions',
      when: rowWhen,
      handler: () => {
        const s = focusedRowEntry();
        if (s) openRowMenuAtRow(s);
      },
    },
    [sessions, renamingId],
  );

  // Group header keyboard shortcuts (Space/Enter = toggle, →/← = expand/collapse)
  const groupHeaderWhen = () => focusedGroupId() !== null;
  useShortcut(
    {
      id: 'sidebar.group.toggle',
      keys: ' ',
      scope: 'sidebar-focused',
      label: 'Toggle group collapse',
      when: groupHeaderWhen,
      handler: () => {
        const gid = focusedGroupId();
        if (gid) toggleCollapse(gid);
      },
    },
    [layout, toggleCollapse],
  );
  useShortcut(
    {
      id: 'sidebar.group.enter',
      keys: 'Enter',
      scope: 'sidebar-focused',
      label: 'Toggle group collapse',
      when: groupHeaderWhen,
      handler: () => {
        const gid = focusedGroupId();
        if (gid) toggleCollapse(gid);
      },
    },
    [layout, toggleCollapse],
  );
  useShortcut(
    {
      id: 'sidebar.group.expand',
      keys: 'ArrowRight',
      scope: 'sidebar-focused',
      label: 'Expand group',
      when: () => {
        const gid = focusedGroupId();
        if (!gid) return false;
        const g = layout.groups.find((x) => x.id === gid);
        return !!g?.collapsed;
      },
      handler: () => {
        const gid = focusedGroupId();
        if (gid) {
          const g = layout.groups.find((x) => x.id === gid);
          if (g?.collapsed) toggleCollapse(gid);
        }
      },
    },
    [layout, toggleCollapse],
  );
  useShortcut(
    {
      id: 'sidebar.group.collapse',
      keys: 'ArrowLeft',
      scope: 'sidebar-focused',
      label: 'Collapse group',
      when: () => {
        const gid = focusedGroupId();
        if (!gid) return false;
        const g = layout.groups.find((x) => x.id === gid);
        return g ? !g.collapsed : false;
      },
      handler: () => {
        const gid = focusedGroupId();
        if (gid) {
          const g = layout.groups.find((x) => x.id === gid);
          if (g && !g.collapsed) toggleCollapse(gid);
        }
      },
    },
    [layout, toggleCollapse],
  );

  const onMenuClose = useCallback(() => {
    closeMenuLocal();
  }, [closeMenuLocal]);

  const currentMenuItems = menu
    ? (() => {
        const s = sessions?.find((x) => x.id === menu.rowId);
        return s ? buildMenu(s) : [];
      })()
    : [];

  // Filter shortcut (B-2). `/` focuses the input. Guarded so we don't
  // steal the key while xterm or any input has focus — xterm.onData
  // already swallows printables when its viewport is focused, but a
  // body-focus state would otherwise hijack a `/` the user typed into,
  // say, the new-session name field.
  useShortcut(
    {
      id: 'sidebar.filter.focus',
      keys: '/',
      scope: 'global',
      label: 'Filter sessions',
      when: () => {
        const el = document.activeElement as HTMLElement | null;
        if (!el) return true;
        const tag = el.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA') return false;
        if (el.isContentEditable) return false;
        // xterm renders its own focusable textarea inside .xterm — caught
        // by the INPUT/TEXTAREA check above. Belt-and-braces: refuse if
        // the focus is anywhere inside an xterm host.
        if (el.closest('.xterm')) return false;
        return true;
      },
      handler: () => filterInputRef.current?.focus(),
    },
    [],
  );

  // Apply filter to the visible list. Combined "name + cwd + kind"
  // substring, case-insensitive. Including kind keywords means typing
  // "shell" (or "sh") narrows to shell tabs regardless of their name.
  // Deep-search (below) still scans message content — this only narrows
  // the visible list. We keep the original sessions array intact for
  // shortcut lookups (focusedRowEntry, menu rowId resolution).
  const q = filter.trim().toLowerCase();
  const visibleSessions = q && sessions
    ? sessions.filter((s) => {
        const hay = ((s.name || '') + ' ' + (s.cwd || '') + ' ' + kindKeyword(s)).toLowerCase();
        return hay.includes(q);
      })
    : sessions;

  // Apply saved order when filter is NOT active. When filter is active we
  // preserve the server order so search results feel natural, and we hide
  // the drag handle so the user doesn't accidentally reorder while searching.
  //
  // applyOrder: for each plain c3Id in `order` (skip "grp:…" Phase-2 slots),
  // push the matching session if it exists in `pool`, then append any
  // remaining sessions that had no saved position.
  function applyOrder(pool: C3Entry[], order: string[]): C3Entry[] {
    const byId = new Map(pool.map((s) => [s.id, s]));
    const result: C3Entry[] = [];
    const placed = new Set<string>();
    for (const id of order) {
      if (id.startsWith('grp:')) continue; // Phase 2 placeholder — skip
      const s = byId.get(id);
      if (s) {
        result.push(s);
        placed.add(id);
      }
    }
    for (const s of pool) {
      if (!placed.has(s.id)) result.push(s);
    }
    return result;
  }

  const orderedSessions: C3Entry[] | null =
    !q && visibleSessions ? applyOrder(visibleSessions, layout.order) : visibleSessions;

  // Build render items (only when filter is off).
  const renderItems: RenderItem[] | null =
    !q && visibleSessions
      ? buildRenderItems(layout, visibleSessions)
      : null;

  // Deep-search trigger. Runs when q has ≥3 chars AND (no name matches
  // OR the user explicitly asked). Debounced 250ms — each keystroke
  // resets the timer. Stale responses are dropped via the token ref.
  // (Use visibleSessions length, not orderedSessions, for the name match
  // count since they have the same entries, just different ordering.)
  const nameMatchCount = visibleSessions?.length ?? 0;
  const shouldDeepSearch =
    q.length >= 3 && sessions !== null && (searchForced || nameMatchCount === 0);
  useEffect(() => {
    // Reset the forced flag when the query shrinks below the threshold
    // — re-typing should not silently re-fire the search.
    if (q.length < 3) {
      if (searchForced) setSearchForced(false);
      if (searchState.kind !== 'idle') setSearchState({ kind: 'idle' });
      return;
    }
    if (!shouldDeepSearch) {
      // We have name matches and user hasn't forced — go back to idle.
      if (searchState.kind !== 'idle') setSearchState({ kind: 'idle' });
      return;
    }
    const token = ++searchTokenRef.current;
    // Cancel any in-flight predecessor.
    if (searchAbortRef.current) searchAbortRef.current.abort();
    const ac = new AbortController();
    searchAbortRef.current = ac;
    const timer = window.setTimeout(() => {
      setSearchState({ kind: 'loading' });
      searchSessions(q, 20, ac.signal)
        .then((res) => {
          if (searchTokenRef.current !== token) return;
          setSearchState({
            kind: 'results',
            matches: res.matches,
            truncated: res.truncated,
            q,
          });
        })
        .catch((err) => {
          if (ac.signal.aborted || searchTokenRef.current !== token) return;
          const msg = err instanceof ApiError ? err.body : 'Search failed';
          setSearchState({ kind: 'error', message: msg });
        });
    }, 250);
    return () => {
      window.clearTimeout(timer);
      ac.abort();
    };
    // searchState intentionally not a dep — would loop the effect on
    // every setState. We only re-run when the inputs change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, shouldDeepSearch]);

  // Lookup map: claudeUuid → C3Entry, used to render a search result row
  // as a clickable session (when bound) or a disabled hint (when not).
  const sessionsByUuid = new Map<string, C3Entry>();
  for (const s of sessions ?? []) {
    if (s.claudeUuid) sessionsByUuid.set(s.claudeUuid, s);
  }
  const openSearchMatch = (m: SearchMatch) => {
    const entry = sessionsByUuid.get(m.claudeUuid);
    if (!entry) return; // unbound: click is disabled below
    onOpen(entry);
    onSessionSelected?.();
  };

  // ---- row reorder drag ------------------------------------------------

  const cancelDrag = useCallback(() => {
    const d = rowDragRef.current;
    if (!d) return;
    d.ghostEl.remove();
    d.indicatorEl.remove();
    d.dropTargetEl?.classList.remove('drop-target');
    document.body.style.cursor = '';
    window.removeEventListener('mousemove', d.onMove);
    window.removeEventListener('mouseup', d.onUp);
    window.removeEventListener('keydown', d.onKey);
    rowDragRef.current = null;
    setDragVersion((v) => v + 1);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const commitDrag = useCallback(() => {
    const d = rowDragRef.current;
    if (!d) { cancelDrag(); return; }

    if (d.groupId === '__group__') {
      // Reorder group headers within top-level order.
      const slots = [...layout.order];
      const slot = 'grp:' + d.draggingId;
      // Rebuild: extract group slots, reorder, stitch back.
      const groupSlots = slots.filter((s) => s.startsWith('grp:'));
      const srcIdx = groupSlots.indexOf(slot);
      if (srcIdx !== -1) {
        groupSlots.splice(srcIdx, 1);
        const insertAt = d.dropIdx > d.sourceIdx ? d.dropIdx - 1 : d.dropIdx;
        groupSlots.splice(Math.max(0, insertAt), 0, slot);
        let gi = 0;
        const newOrder = slots.map((s) => (s.startsWith('grp:') ? groupSlots[gi++] : s));
        setLayout({ ...layout, order: newOrder });
      }
    } else {
      // Cross-scope row move: relocate draggingId into the destination scope
      // (d.dstGroupId: null = ungrouped top level, else a group) at d.dropIdx.
      // dropIdx was computed over the destination scope's rows EXCLUDING the
      // dragged row, so it's a direct insertion index (no off-by-one fixup).
      if (!renderItems) { cancelDrag(); return; }
      const id = d.draggingId;
      const dst = d.dstGroupId;

      const topSeq = buildTopSeq(renderItems);

      // Detach the dragged id from wherever it currently lives.
      let order = topSeq.filter((s) => s !== id);
      let groups = layout.groups.map((g) => ({
        ...g,
        memberOrder: g.memberOrder.filter((m) => m !== id),
      }));

      if (dst === null) {
        // Insert at the dropIdx-th ungrouped slot; group slots stay anchored.
        const ungIdxs: number[] = [];
        order.forEach((s, i) => { if (!s.startsWith('grp:')) ungIdxs.push(i); });
        const insertPos =
          d.dropIdx >= ungIdxs.length
            ? (ungIdxs.length > 0 ? ungIdxs[ungIdxs.length - 1] + 1 : order.length)
            : ungIdxs[d.dropIdx];
        order = [...order.slice(0, insertPos), id, ...order.slice(insertPos)];
      } else {
        groups = groups.map((g) => {
          if (g.id !== dst) return g;
          const at = Math.min(Math.max(0, d.dropIdx), g.memberOrder.length);
          return {
            ...g,
            memberOrder: [
              ...g.memberOrder.slice(0, at),
              id,
              ...g.memberOrder.slice(at),
            ],
          };
        });
      }

      setLayout({ ...layout, order, groups });
    }

    cancelDrag();
  }, [cancelDrag, layout, renderItems, setLayout]);

  const startDrag = useCallback(
    (e: React.MouseEvent, c3Id: string, groupId: string | null) => {
      if (groupId === null && !orderedSessions) return;
      e.preventDefault();

      const handleEl = e.currentTarget as HTMLElement;
      const li = handleEl.closest('li') as HTMLLIElement | null;
      if (!li) return;

      let sourceIdx: number;
      if (groupId === null) {
        sourceIdx = orderedSessions!.findIndex((s) => s.id === c3Id);
      } else {
        const g = layout.groups.find((x) => x.id === groupId);
        sourceIdx = g ? g.memberOrder.indexOf(c3Id) : -1;
      }
      if (sourceIdx === -1) return;

      const rect = li.getBoundingClientRect();
      const offsetX = e.clientX - rect.left;
      const offsetY = e.clientY - rect.top;

      // Ghost: visual clone that follows the cursor.
      const ghost = document.createElement('div');
      ghost.style.cssText = [
        'position:fixed',
        `left:${rect.left}px`,
        `top:${rect.top}px`,
        `width:${rect.width}px`,
        'pointer-events:none',
        'opacity:0.55',
        'box-shadow:0 4px 16px rgba(0,0,0,0.4)',
        'z-index:1000',
        'background:var(--sidebar-bg)',
        'border-radius:2px',
      ].join(';');
      ghost.innerHTML = li.outerHTML;
      document.body.appendChild(ghost);

      // Drop indicator: a 2 px accent line inserted in the list.
      const indicator = document.createElement('div');
      indicator.className = 'sidebar-drop-indicator';
      sessionListRef.current?.appendChild(indicator);

      document.body.style.cursor = 'grabbing';

      // Rows of a destination scope, excluding the dragged row itself so the
      // computed index is a direct insertion index (no off-by-one fixup).
      const scopeRows = (dst: string | null): HTMLElement[] => {
        const list = sessionListRef.current;
        if (!list) return [];
        const sel =
          dst === null
            ? 'li.session:not(.session-in-group)'
            : `li.session.session-in-group[data-group-id="${dst}"]`;
        return Array.from(list.querySelectorAll<HTMLElement>(sel)).filter(
          (r) => r.dataset.rowId !== c3Id,
        );
      };

      type Drop = { dst: string | null; dropIdx: number; targetEl: HTMLElement | null };

      // Resolve which scope (ungrouped vs a group) the cursor is over and the
      // insertion index within it. Supports dropping onto a collapsed group
      // header or an empty group's placeholder (highlight, append/0).
      const resolveDrop = (clientX: number, clientY: number): Drop => {
        const list = sessionListRef.current;
        const el = document.elementFromPoint(clientX, clientY) as HTMLElement | null;
        const midIdx = (rows: HTMLElement[]): number => {
          for (let i = 0; i < rows.length; i++) {
            const r = rows[i].getBoundingClientRect();
            if (clientY < r.top + r.height / 2) return i;
          }
          return rows.length;
        };
        if (el && list) {
          const header = el.closest<HTMLElement>('li.session-group-header[data-group-id]');
          const emptyPh = el.closest<HTMLElement>('li.session-group-empty[data-group-id]');
          const inGroupRow = el.closest<HTMLElement>('li.session.session-in-group[data-group-id]');
          if (header) {
            const gid = header.dataset.groupId!;
            // Authoritative collapsed state from layout, not inferred from DOM.
            const collapsed = !!layout.groups.find((g) => g.id === gid)?.collapsed;
            if (collapsed) {
              // Members hidden — append to the group, highlight the header.
              return { dst: gid, dropIdx: Number.MAX_SAFE_INTEGER, targetEl: header };
            }
            const members = scopeRows(gid);
            if (members.length === 0) {
              // Expanded with no droppable rows (truly empty, or its only
              // member is the row being dragged) — highlight header, drop at 0.
              return { dst: gid, dropIdx: 0, targetEl: header };
            }
            // Header of an expanded group with members: drop before the first.
            return { dst: gid, dropIdx: 0, targetEl: null };
          }
          if (emptyPh) {
            return { dst: emptyPh.dataset.groupId!, dropIdx: 0, targetEl: emptyPh };
          }
          if (inGroupRow) {
            const gid = inGroupRow.dataset.groupId!;
            return { dst: gid, dropIdx: midIdx(scopeRows(gid)), targetEl: null };
          }
        }
        // Ungrouped top level (over an ungrouped row or list background).
        return { dst: null, dropIdx: midIdx(scopeRows(null)), targetEl: null };
      };

      // Position the 2px indicator within the destination scope at dropIdx.
      const placeIndicator = (dst: string | null, dropIdx: number) => {
        const list = sessionListRef.current;
        if (!list) return;
        const rows = scopeRows(dst);
        indicator.style.display = 'block';
        if (rows.length === 0) {
          list.appendChild(indicator);
        } else if (dropIdx >= rows.length) {
          const last = rows[rows.length - 1];
          list.insertBefore(indicator, last.nextSibling);
        } else {
          list.insertBefore(indicator, rows[dropIdx]);
        }
      };

      const applyDrop = (res: Drop) => {
        const d = rowDragRef.current;
        if (!d) return;
        if (d.dropTargetEl && d.dropTargetEl !== res.targetEl) {
          d.dropTargetEl.classList.remove('drop-target');
        }
        d.dstGroupId = res.dst;
        d.dropIdx = res.dropIdx;
        d.dropTargetEl = res.targetEl;
        if (res.targetEl) {
          indicator.style.display = 'none';
          res.targetEl.classList.add('drop-target');
        } else {
          placeIndicator(res.dst, res.dropIdx);
        }
      };

      const actualMoveHandler = (ev: MouseEvent) => {
        const d = rowDragRef.current;
        if (!d) return;
        d.ghostEl.style.left = `${ev.clientX - d.offsetX}px`;
        d.ghostEl.style.top = `${ev.clientY - d.offsetY}px`;
        applyDrop(resolveDrop(ev.clientX, ev.clientY));
      };

      const actualUpHandler = () => {
        commitDrag();
      };

      const actualKeyHandler = (ev: KeyboardEvent) => {
        if (ev.key === 'Escape') cancelDrag();
      };

      rowDragRef.current = {
        draggingId: c3Id,
        groupId,
        // startDrag handles session rows only (never group headers), so the
        // source scope is the initial destination scope.
        dstGroupId: groupId,
        dropTargetEl: null,
        ghostEl: ghost,
        sourceIdx,
        dropIdx: sourceIdx,
        indicatorEl: indicator,
        offsetX,
        offsetY,
        onMove: actualMoveHandler,
        onUp: actualUpHandler,
        onKey: actualKeyHandler,
      };

      applyDrop(resolveDrop(e.clientX, e.clientY));
      window.addEventListener('mousemove', actualMoveHandler);
      window.addEventListener('mouseup', actualUpHandler);
      window.addEventListener('keydown', actualKeyHandler);
      setDragVersion((v) => v + 1);
    },
    [cancelDrag, commitDrag, layout.groups, orderedSessions],
  );

  // Drag for group headers (reorder groups in top-level order).
  const startGroupDrag = useCallback(
    (e: React.MouseEvent, groupId: string) => {
      e.preventDefault();

      const handleEl = e.currentTarget as HTMLElement;
      const li = handleEl.closest('li') as HTMLLIElement | null;
      if (!li) return;

      // sourceIdx = position among group headers in order.
      const groupSlots = layout.order.filter((s) => s.startsWith('grp:'));
      const sourceIdx = groupSlots.indexOf('grp:' + groupId);
      if (sourceIdx === -1) return;

      const rect = li.getBoundingClientRect();
      const offsetX = e.clientX - rect.left;
      const offsetY = e.clientY - rect.top;

      const ghost = document.createElement('div');
      ghost.style.cssText = [
        'position:fixed',
        `left:${rect.left}px`,
        `top:${rect.top}px`,
        `width:${rect.width}px`,
        'pointer-events:none',
        'opacity:0.55',
        'box-shadow:0 4px 16px rgba(0,0,0,0.4)',
        'z-index:1000',
        'background:var(--sidebar-bg)',
        'border-radius:2px',
      ].join(';');
      ghost.innerHTML = li.outerHTML;
      document.body.appendChild(ghost);

      const indicator = document.createElement('div');
      indicator.className = 'sidebar-drop-indicator';
      sessionListRef.current?.appendChild(indicator);

      document.body.style.cursor = 'grabbing';

      const calcDropIdx = (clientY: number): number => {
        const list = sessionListRef.current;
        if (!list) return sourceIdx;
        const headers = Array.from(list.querySelectorAll<HTMLElement>('li.session-group-header'));
        for (let i = 0; i < headers.length; i++) {
          const r = headers[i].getBoundingClientRect();
          if (clientY < r.top + r.height / 2) return i;
        }
        return headers.length;
      };

      const placeIndicator = (dropIdx: number) => {
        const list = sessionListRef.current;
        if (!list) return;
        const headers = Array.from(list.querySelectorAll<HTMLElement>('li.session-group-header'));
        if (headers.length === 0) return;
        indicator.style.display = 'block';
        if (dropIdx < headers.length) {
          list.insertBefore(indicator, headers[dropIdx]);
        } else {
          list.appendChild(indicator);
        }
      };

      const actualMoveHandler = (ev: MouseEvent) => {
        const d = rowDragRef.current;
        if (!d) return;
        d.ghostEl.style.left = `${ev.clientX - d.offsetX}px`;
        d.ghostEl.style.top = `${ev.clientY - d.offsetY}px`;
        const newDropIdx = calcDropIdx(ev.clientY);
        if (newDropIdx !== d.dropIdx) {
          d.dropIdx = newDropIdx;
          placeIndicator(newDropIdx);
        }
      };
      const actualUpHandler = () => commitDrag();
      const actualKeyHandler = (ev: KeyboardEvent) => {
        if (ev.key === 'Escape') cancelDrag();
      };

      rowDragRef.current = {
        draggingId: groupId,
        groupId: '__group__',
        dstGroupId: null,
        dropTargetEl: null,
        ghostEl: ghost,
        sourceIdx,
        dropIdx: sourceIdx,
        indicatorEl: indicator,
        offsetX,
        offsetY,
        onMove: actualMoveHandler,
        onUp: actualUpHandler,
        onKey: actualKeyHandler,
      };

      placeIndicator(sourceIdx);
      window.addEventListener('mousemove', actualMoveHandler);
      window.addEventListener('mouseup', actualUpHandler);
      window.addEventListener('keydown', actualKeyHandler);
      setDragVersion((v) => v + 1);
    },
    [cancelDrag, commitDrag, layout.order],
  );

  // Suppress dragVersion from "unused variable" — its purpose is purely
  // to re-render after drag operations. Referencing it in the JSX would
  // work but adds visual noise; this void keeps TS happy.
  void dragVersion;

  // ---- keyboard reorder (Alt+↑/↓) ----------------------------------------

  // Nudge a row one step within its own scope. An in-group row reorders
  // inside the group's memberOrder; an ungrouped row reorders within the
  // ungrouped subsequence of a "grp:"-slot-preserving order (rebuilding from
  // orderedSessions would drop group slots and make groups vanish).
  const reorderRow = useCallback(
    (s: C3Entry, dir: -1 | 1) => {
      if (q || !renderItems) return;
      const g = findGroupOf(s.id);
      if (g) {
        const ids = [...g.memberOrder];
        const idx = ids.indexOf(s.id);
        const j = idx + dir;
        if (idx < 0 || j < 0 || j >= ids.length) return;
        [ids[idx], ids[j]] = [ids[j], ids[idx]];
        setLayout({
          ...layout,
          groups: layout.groups.map((x) =>
            x.id === g.id ? { ...x, memberOrder: ids } : x,
          ),
        });
      } else {
        const topSeq = buildTopSeq(renderItems);
        const ungIdxs: number[] = [];
        topSeq.forEach((x, i) => { if (!x.startsWith('grp:')) ungIdxs.push(i); });
        const pos = topSeq.indexOf(s.id);
        const ungPos = ungIdxs.indexOf(pos);
        const targetUng = ungPos + dir;
        if (ungPos < 0 || targetUng < 0 || targetUng >= ungIdxs.length) return;
        const a = ungIdxs[ungPos];
        const b = ungIdxs[targetUng];
        const next = [...topSeq];
        [next[a], next[b]] = [next[b], next[a]];
        setLayout({ ...layout, order: next });
      }
      // Re-focus the moved row after re-render.
      window.setTimeout(() => {
        rowRefs.current.get(s.id)?.focus();
      }, 0);
    },
    [q, renderItems, findGroupOf, layout, setLayout],
  );

  // Move a group one top-level position up/down — swap its "grp:" slot with
  // the adjacent top-level entry (an ungrouped session or another group), the
  // keyboard mirror of the drag handle. Single-step semantics, so a group can
  // be nudged in between ungrouped rows (which group-header drag can't do).
  const reorderGroup = useCallback(
    (gid: string, dir: -1 | 1) => {
      if (q || !renderItems) return;
      const seq = buildTopSeq(renderItems);
      const idx = seq.indexOf('grp:' + gid);
      const j = idx + dir;
      if (idx < 0 || j < 0 || j >= seq.length) return;
      [seq[idx], seq[j]] = [seq[j], seq[idx]];
      setLayout({ ...layout, order: seq });
      // Re-focus the moved group header after re-render.
      window.setTimeout(() => {
        sessionListRef.current
          ?.querySelector<HTMLElement>(`li.session-group-header[data-group-id="${gid}"]`)
          ?.focus();
      }, 0);
    },
    [q, renderItems, layout, setLayout],
  );

  useShortcut(
    {
      id: 'sidebar.group.moveUp',
      keys: 'Alt+ArrowUp',
      scope: 'sidebar-focused',
      label: 'Move focused group up',
      when: () => focusedGroupId() !== null && !q,
      handler: () => {
        const gid = focusedGroupId();
        if (gid) reorderGroup(gid, -1);
      },
    },
    [q, reorderGroup],
  );

  useShortcut(
    {
      id: 'sidebar.group.moveDown',
      keys: 'Alt+ArrowDown',
      scope: 'sidebar-focused',
      label: 'Move focused group down',
      when: () => focusedGroupId() !== null && !q,
      handler: () => {
        const gid = focusedGroupId();
        if (gid) reorderGroup(gid, 1);
      },
    },
    [q, reorderGroup],
  );

  useShortcut(
    {
      id: 'sidebar.row.moveUp',
      keys: 'Alt+ArrowUp',
      scope: 'sidebar-focused',
      label: 'Move focused session up',
      when: () => focusedRowEntry() !== null && !q,
      handler: () => {
        const s = focusedRowEntry();
        if (s) reorderRow(s, -1);
      },
    },
    [q, reorderRow, sessions, renamingId],
  );

  useShortcut(
    {
      id: 'sidebar.row.moveDown',
      keys: 'Alt+ArrowDown',
      scope: 'sidebar-focused',
      label: 'Move focused session down',
      when: () => focusedRowEntry() !== null && !q,
      handler: () => {
        const s = focusedRowEntry();
        if (s) reorderRow(s, 1);
      },
    },
    [q, reorderRow, sessions, renamingId],
  );

  // Inline width override only in wide mode — narrow / drawer keeps the
  // fixed 280px from CSS so the slide-in math doesn't depend on a JS var.
  const asideStyle = resizable ? { width: `${width}px`, flexBasis: `${width}px` } : undefined;

  // ---- session row renderer (shared between ungrouped + in-group) ---------

  const renderSessionRow = (s: C3Entry, inGroup: boolean, groupId?: string) => {
    // Shell entries are NOT "pending" — they have no claudeUuid by
    // design and their PTY spawns immediately on attach. Without
    // this guard the row picks up the pending CSS hue and the
    // ARIA label says "click to start" (wrong for shell tabs).
    const pending = !s.claudeUuid && s.kind !== 'shell';
    // Each pane is uniquely identified by its c3Id; activeC3Id is
    // the focused pane's c3Id, openSet contains every attached pane.
    const isActive = !pending && s.id === activeC3Id;
    const isOpen = !pending && openSet.has(s.id);
    const openTabIdx = openByC3.get(s.id);
    const isDraggingThis = rowDragRef.current?.draggingId === s.id;
    const className =
      'session' +
      (isActive ? ' active' : '') +
      (pending ? ' pending' : '') +
      (isOpen && !isActive ? ' open' : '') +
      (isDraggingThis ? ' dragging-source' : '') +
      (inGroup ? ' session-in-group' : '');
    const cwdLabel = s.cwd || '';
    const isRenaming = renamingId === s.id;
    // C-3: hue derives from cwd so multiple sessions on the same
    // project share an accent, but different projects pop apart.
    // Inline as a CSS custom property — CSS owns the actual usage
    // (border-left strip, hover glow, monogram chip).
    const rowTint = cwdTint(s.cwd || '');
    const rowTintFg = cwdTintFg(s.cwd || '');
    const monogram = cwdMonogram(s.cwd || '');
    const rowStyle = {
      '--row-tint': rowTint,
      '--row-tint-fg': rowTintFg,
    } as React.CSSProperties;

    // Enter (button activation) and the ContextMenu key stay
    // local — they're row semantics, not app-level shortcuts.
    // r / a / Delete / Backspace live in the shortcut registry
    // above (scope 'sidebar-focused').
    const onRowKey = (e: React.KeyboardEvent<HTMLLIElement>) => {
      if (isRenaming) return;
      if (e.key === 'Enter') {
        e.preventDefault();
        // Pending entries open too: server spawns claude no-resume
        // (D-7) and sends {type:'pending'} → {type:'ready'} frames
        // for the banner/disableStdin handling.
        onOpen(s);
        onSessionSelected?.();
      } else if (e.key === 'ContextMenu') {
        e.preventDefault();
        const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
        setMenu({ rowId: s.id, x: rect.right - 200, y: rect.bottom });
      }
    };

    return (
      <li
        key={s.id}
        ref={(el) => {
          rowRefs.current.set(s.id, el);
        }}
        data-row-id={s.id}
        data-group-id={groupId}
        className={className}
        style={rowStyle}
        onClick={() => {
          if (isRenaming) return;
          closePreview();
          onOpen(s);
          onSessionSelected?.();
        }}
        onKeyDown={onRowKey}
        onMouseEnter={(e) => onRowMouseEnter(s, e.currentTarget)}
        onMouseLeave={onRowMouseLeave}
        onContextMenu={(e) => {
          e.preventDefault();
          closePreview();
          setMenu({ rowId: s.id, x: e.clientX, y: e.clientY });
        }}
        tabIndex={0}
        role="button"
        aria-current={isActive ? 'true' : undefined}
        aria-label={
          pending
            ? `${s.name || s.id} (pending session — click to start)`
            : undefined
        }
        title={
          isOpen && openTabIdx !== undefined
            ? `Already open in tab ${openTabIdx + 1}${cwdLabel ? ` — ${cwdLabel}` : ''}`
            : cwdLabel
        }
      >
        <div className="session-name">
          {!q && (
            <span
              className="sidebar-drag-handle"
              aria-label="Drag to reorder"
              title="Drag to reorder"
              onMouseDown={(e) => startDrag(e, s.id, groupId ?? null)}
              onClick={(e) => e.stopPropagation()}
            >
              ⠿
            </span>
          )}
          <span
            className="session-monogram"
            aria-hidden="true"
            title={cwdLabel || undefined}
          >
            {monogram}
          </span>
          {!pending && s.live && (
            <Sparkline
              buckets={activity.get(s.id) ?? null}
              // On the active row the background is also the
              // tint, so painting bars in the same hue makes
              // them disappear. Use the lighter "fg" variant
              // there for contrast.
              color={isActive ? rowTintFg : rowTint}
            />
          )}
          {isRenaming ? (
            <input
              type="text"
              autoFocus
              className="rename-input"
              value={renameDraft}
              maxLength={80}
              onChange={(e) => setRenameDraft(e.target.value)}
              onBlur={() => void commitRename(s)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  void commitRename(s);
                } else if (e.key === 'Escape') {
                  e.preventDefault();
                  renameCancelledRef.current = true;
                  setRenamingId(null);
                }
                e.stopPropagation();
              }}
              onClick={(e) => e.stopPropagation()}
            />
          ) : (
            <>
              {s.kind === 'shell' && (
                <span
                  className="badge sidebar-row-kind-badge"
                  title="Plain shell tab"
                >
                  sh
                </span>
              )}
              <span className="session-name-text">{s.name || s.id}</span>
              {/* Single priority-based status indicator — only one shows at a time.
                  Priority: attention > exit > open > warm-background > pending */}
              {bellSet?.has(s.id) ? (
                <span
                  className="sidebar-attn-dot"
                  aria-label="Waiting for input"
                  title="Waiting for input"
                />
              ) : exitMap?.has(s.id) ? (
                <span
                  className={exitMap.get(s.id) === 0 ? 'sidebar-exit-ok' : 'sidebar-exit-err'}
                  aria-label={exitMap.get(s.id) === 0 ? 'Exited OK' : `Exited with error (code ${exitMap.get(s.id)})`}
                  title={exitMap.get(s.id) === 0 ? 'Exited OK' : `Exited — code ${exitMap.get(s.id)}`}
                >
                  {exitMap.get(s.id) === 0 ? '✓' : '✗'}
                </span>
              ) : isOpen ? (
                <span className="dot" aria-label="Open in tab" />
              ) : s.live && !pending ? (
                <span
                  className="sidebar-warm-dot"
                  aria-label="Running in background"
                  title="Claude is running in the background"
                />
              ) : pending ? (
                <span
                  className="sidebar-pending-indicator"
                  aria-label="Initializing"
                  title="Session is initializing…"
                >…</span>
              ) : null}
            </>
          )}
          <button
            type="button"
            className="session-menu-btn"
            aria-label="Row actions"
            tabIndex={-1}
            onClick={(e) => {
              e.stopPropagation();
              const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
              setMenu({ rowId: s.id, x: rect.left, y: rect.bottom });
            }}
          >
            ⋯
          </button>
        </div>
        <div className="session-cwd">{cwdLabel}</div>
        {!pending && <div className="session-uuid">{s.claudeUuid.slice(0, 8)}</div>}
      </li>
    );
  };

  // ---- group header renderer ---------------------------------------------

  const renderGroupHeader = (g: SidebarGroup, members: C3Entry[]) => {
    const memberCount = members.length;
    // Aggregate member status onto the header, but only when collapsed —
    // expanded groups already show each member's own indicator, so a header
    // rollup would be redundant noise.
    const rollup = g.collapsed ? groupStatusRollup(members, bellSet, exitMap) : null;
    const isRenaming = renamingGroupId === g.id;
    const isArmed = armedGroupId === g.id;
    const isDraggingThis =
      rowDragRef.current?.groupId === '__group__' &&
      rowDragRef.current?.draggingId === g.id;

    return (
      <li
        key={`group-${g.id}`}
        data-group-id={g.id}
        className={'session-group-header' + (isDraggingThis ? ' dragging-source' : '')}
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === ' ' || e.key === 'Enter') {
            e.preventDefault();
            toggleCollapse(g.id);
          }
        }}
      >
        {!q && (
          <span
            className="group-drag-handle"
            aria-label="Drag group to reorder"
            title="Drag to reorder group"
            onMouseDown={(e) => startGroupDrag(e, g.id)}
            onClick={(e) => e.stopPropagation()}
          >
            ⠿
          </span>
        )}
        <button
          className="group-chevron"
          onClick={() => toggleCollapse(g.id)}
          aria-label={g.collapsed ? 'Expand group' : 'Collapse group'}
          tabIndex={-1}
        >
          {g.collapsed ? '▸' : '▾'}
        </button>
        {isRenaming ? (
          <input
            className="group-rename-input"
            type="text"
            autoFocus
            value={renameGroupDraft}
            maxLength={60}
            onFocus={(e) => e.target.select()}
            onChange={(e) => setRenameGroupDraft(e.target.value)}
            onBlur={commitGroupRename}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                commitGroupRename();
              } else if (e.key === 'Escape') {
                e.preventDefault();
                setRenamingGroupId(null);
              }
              e.stopPropagation();
            }}
            onClick={(e) => e.stopPropagation()}
          />
        ) : (
          <span
            className="group-name"
            onDoubleClick={() => startGroupRename(g.id)}
            title="Double-click to rename"
          >
            {g.name}
          </span>
        )}
        {g.collapsed && memberCount > 0 && (
          <span className="group-count">({memberCount})</span>
        )}
        {rollup === 'attn' ? (
          <span
            className="sidebar-attn-dot"
            aria-label="A session in this group is waiting for input"
            title="A session in this group is waiting for input"
          />
        ) : rollup === 'exit-err' ? (
          <span
            className="sidebar-exit-err"
            aria-label="A session in this group exited with an error"
            title="A session in this group exited with an error"
          >
            ✗
          </span>
        ) : rollup === 'exit-ok' ? (
          <span
            className="sidebar-exit-ok"
            aria-label="A session in this group exited"
            title="A session in this group exited"
          >
            ✓
          </span>
        ) : rollup === 'warm' ? (
          <span
            className="sidebar-warm-dot"
            aria-label="A session in this group is running in the background"
            title="A session in this group is running in the background"
          />
        ) : rollup === 'pending' ? (
          <span
            className="sidebar-pending-indicator"
            aria-label="A session in this group is initializing"
            title="A session in this group is initializing…"
          >
            …
          </span>
        ) : null}
        <button
          className={'group-delete-btn' + (isArmed ? ' armed' : '')}
          onClick={(e) => {
            e.stopPropagation();
            triggerGroupDelete(g.id);
          }}
          aria-label={isArmed ? 'Confirm delete group' : 'Delete group'}
          title={isArmed ? 'Click again to confirm delete' : 'Delete group (sessions become ungrouped)'}
          tabIndex={-1}
        >
          {isArmed ? '✓?' : '×'}
        </button>
      </li>
    );
  };

  return (
    <aside
      className="sidebar"
      aria-label="Sessions"
      style={asideStyle}
    >
      {resizable && (
        <div
          ref={resizerRef}
          className="sidebar-resizer"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize sidebar"
          aria-valuenow={width}
          aria-valuemin={SIDEBAR_W_MIN}
          aria-valuemax={SIDEBAR_W_MAX}
          tabIndex={0}
          onMouseDown={onResizerMouseDown}
          onDoubleClick={onResizerDblClick}
          onKeyDown={onResizerKeyDown}
          title="Drag to resize · double-click to reset"
        />
      )}
      <header className="sidebar-header">
        <h1>Sessions</h1>
        <button
          className="icon-btn"
          onClick={onRefresh}
          title="Refresh"
          aria-label="Refresh sessions"
        >
          ↻
        </button>
      </header>

      <div className="sidebar-controls">
        <div
          className="segmented"
          role="tablist"
          aria-label="Session view"
        >
          <button
            type="button"
            role="tab"
            aria-selected={view === 'active'}
            tabIndex={view === 'active' ? 0 : -1}
            className={'segmented-btn' + (view === 'active' ? ' active' : '')}
            onClick={() => onViewChange('active')}
          >
            Active
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={view === 'archived'}
            tabIndex={view === 'archived' ? 0 : -1}
            className={'segmented-btn' + (view === 'archived' ? ' active' : '')}
            onClick={() => onViewChange('archived')}
          >
            Archived
          </button>
        </div>

        <div className="sidebar-filter">
          <span className="sidebar-filter-icon" aria-hidden="true">⌕</span>
          <input
            ref={filterInputRef}
            type="text"
            className="sidebar-filter-input"
            placeholder="filter sessions… (/)"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault();
                if (filter) setFilter('');
                else (e.target as HTMLInputElement).blur();
              }
              // Don't let single-letter row shortcuts (r/a) fire while
              // the user is typing in the filter — registry's `when`
              // already guards on focused-row, but stopPropagation here
              // keeps the keydown contract crystal clear.
              e.stopPropagation();
            }}
            aria-label="Filter sessions"
          />
          {filter && (
            <button
              type="button"
              className="sidebar-filter-clear"
              onClick={() => {
                setFilter('');
                filterInputRef.current?.focus();
              }}
              aria-label="Clear filter"
              tabIndex={-1}
            >
              ×
            </button>
          )}
        </div>

        {/* Three-icon "new tab" strip — replaces the v0.2.x "+ New session"
          * primary button + "Bind existing…" secondary. Each icon is a
          * direct entrypoint for one tab kind: Claude (modern first-prompt
          * flow in main pane), Shell (plain $SHELL -i, inline form), Bind
          * (adopt existing Claude uuid, inline form). Same row, equal weight. */}
        <div className="sidebar-kind-icons" role="group" aria-label="New tab">
          <button
            type="button"
            className="sidebar-kind-icon"
            onClick={() => {
              // Claude goes to the main-pane NewSessionPane (modern inline
              // first-prompt flow). Close any open sidebar form first so
              // the user doesn't end up with two new-tab UIs visible at
              // the same time (Bind/Shell form below + NewSessionPane in
              // main). Fallback toggles the legacy inline form if no
              // handler is wired.
              setCreating(false);
              if (onRequestCreate) {
                onRequestCreate();
                return;
              }
              setCreatingMode('new');
              setCreating(true);
            }}
            aria-label="New Claude session"
            data-tooltip="New Claude session"
          >
            <span className="sidebar-kind-icon-glyph" aria-hidden="true">✦</span>
          </button>
          <button
            type="button"
            className="sidebar-kind-icon"
            onClick={() => {
              if (creating && creatingMode === 'shell') {
                setInlineFlashKey((k) => k + 1);
                return;
              }
              onCloseMainPane?.(); // symmetric with Claude icon's setCreating(false)
              setCreatingMode('shell');
              setCreating(true);
            }}
            aria-label="New shell tab"
            data-tooltip="New shell tab"
          >
            <span className="sidebar-kind-icon-glyph" aria-hidden="true">$_</span>
          </button>
          <button
            type="button"
            className="sidebar-kind-icon"
            onClick={() => {
              if (creating && creatingMode === 'bind') {
                setInlineFlashKey((k) => k + 1);
                return;
              }
              onCloseMainPane?.(); // symmetric with Claude icon's setCreating(false)
              setCreatingMode('bind');
              setCreating(true);
            }}
            aria-label="Adopt existing Claude session"
            data-tooltip="Adopt existing Claude session"
          >
            <span className="sidebar-kind-icon-glyph" aria-hidden="true">↪</span>
          </button>
          <button
            type="button"
            className="sidebar-kind-icon"
            onClick={createGroupAndRename}
            aria-label="New group"
            data-tooltip="New group"
          >
            <span className="sidebar-kind-icon-glyph" aria-hidden="true">▦</span>
          </button>
        </div>

        {creating && !narrow && (
          <NewSessionForm
            // key by mode so flipping Shell↔Bind unmounts the previous
            // form — otherwise cwd/name/uuidQuery typed in one mode
            // persists invisibly into the other (state lives on a
            // single component instance shared by all modes).
            key={creatingMode}
            drawer={false}
            initialMode={creatingMode}
            onCancel={() => setCreating(false)}
            onCreated={(entry) => {
              setCreating(false);
              // Inherit the active session's group before opening (onOpen
              // changes the active session). activeC3Id is still the
              // pre-create active row here since the form lives in the sidebar.
              placeNewSession(entry.id, activeC3Id);
              onAfterMutate();
              // Auto-open the new entry's tab if it already has a uuid;
              // pending entries (uuid empty) will spawn-on-attach.
              onOpen(entry);
            }}
            showToast={showToast}
            flashKey={inlineFlashKey}
          />
        )}
      </div>

      {creating && narrow && (
        <NewSessionForm
          key={creatingMode}
          drawer={true}
          initialMode={creatingMode}
          onCancel={() => setCreating(false)}
          onCreated={(entry) => {
            setCreating(false);
            placeNewSession(entry.id, activeC3Id);
            onAfterMutate();
            onOpen(entry);
          }}
          showToast={showToast}
          flashKey={inlineFlashKey}
        />
      )}

      {sessions === null ? (
        <ul className="session-list" aria-busy="true" aria-label="Loading sessions">
          {Array.from({ length: 5 }).map((_, i) => (
            <li key={i} className="session session-skeleton" aria-hidden="true">
              <div className="skeleton-line skeleton-line-name" />
              <div className="skeleton-line skeleton-line-cwd" />
            </li>
          ))}
        </ul>
      ) : visibleSessions && visibleSessions.length === 0 ? (
        <div className="empty-hint">
          {q ? (
            <>No sessions match <code>{filter}</code>.</>
          ) : view === 'archived' ? (
            'No archived sessions.'
          ) : (
            <>
              No sessions yet. Run <code>claude</code> in your terminal, or use
              the icons above (✦ Claude · $_ shell · ↪ bind).
            </>
          )}
        </div>
      ) : (
        <ul className="session-list" ref={sessionListRef}>
          {q
            ? // Filter active: flat list, no groups
              (orderedSessions ?? []).map((s) => renderSessionRow(s, false))
            : // No filter: render mixed items (groups + ungrouped)
              (renderItems ?? []).map((item) => {
                if (item.type === 'group') {
                  return renderGroupHeader(item.group, item.members);
                }
                if (item.type === 'group-empty') {
                  return (
                    <li
                      key={`empty-${item.groupId}`}
                      className="session-group-empty"
                      data-group-id={item.groupId}
                      aria-hidden="true"
                    >
                      empty — move sessions here
                    </li>
                  );
                }
                return renderSessionRow(
                  item.session,
                  item.inGroup,
                  item.inGroup ? item.groupId : undefined,
                );
              })
          }
        </ul>
      )}

      {/* Deep-search results section. Rendered below the regular list
          whether or not name matches are present (when both exist, the
          user explicitly clicked "Search messages…"). */}
      {q.length >= 3 && (
        <div className="sidebar-search">
          {nameMatchCount > 0 && searchState.kind === 'idle' && (
            <button
              type="button"
              className="sidebar-search-trigger"
              onClick={() => setSearchForced(true)}
              title="Full-text search across Claude JSONL files"
            >
              Search messages for <code>{filter}</code>…
            </button>
          )}
          {searchState.kind === 'loading' && (
            <div className="sidebar-search-status">Searching messages…</div>
          )}
          {searchState.kind === 'error' && (
            <div className="sidebar-search-status sidebar-search-error">
              {searchState.message}
            </div>
          )}
          {searchState.kind === 'results' && (
            <>
              <div className="sidebar-search-header">
                Messages ({searchState.matches.length}
                {searchState.truncated ? '+' : ''})
              </div>
              {searchState.matches.length === 0 ? (
                <div className="sidebar-search-status">
                  No messages match <code>{filter}</code>.
                </div>
              ) : (
                <ul className="sidebar-search-list">
                  {searchState.matches.map((m) => {
                    const entry = sessionsByUuid.get(m.claudeUuid);
                    const bound = !!entry;
                    const name = entry?.name || entry?.id || m.claudeUuid.slice(0, 8);
                    return (
                      <li
                        key={m.claudeUuid}
                        className={
                          'sidebar-search-row' + (bound ? '' : ' unbound')
                        }
                        onClick={bound ? () => openSearchMatch(m) : undefined}
                        role={bound ? 'button' : undefined}
                        tabIndex={bound ? 0 : -1}
                        onKeyDown={
                          bound
                            ? (e) => {
                                if (e.key === 'Enter' || e.key === ' ') {
                                  e.preventDefault();
                                  openSearchMatch(m);
                                }
                              }
                            : undefined
                        }
                        title={m.cwd}
                      >
                        <div className="sidebar-search-name">{name}</div>
                        <div className="sidebar-search-cwd">{m.cwd}</div>
                        <div className="sidebar-search-snippet">
                          {m.snippet}
                        </div>
                        {!bound && (
                          <div className="sidebar-search-hint">
                            Click <em>Bind</em> in the sidebar first.
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </>
          )}
        </div>
      )}

      {menu && currentMenuItems.length > 0 && (
        <SessionRowMenu
          id={`menu-${menu.rowId}`}
          x={menu.x}
          y={menu.y}
          items={currentMenuItems}
          onClose={onMenuClose}
        />
      )}

      {/* Move-to-group popover */}
      {moveGroupPopover && (
        <>
          {/* Backdrop to close on outside click */}
          <div
            style={{ position: 'fixed', inset: 0, zIndex: 299 }}
            onClick={() => setMoveGroupPopover(null)}
          />
          <div
            className="move-group-popover"
            style={{ left: moveGroupPopover.x, top: moveGroupPopover.y }}
          >
            {layout.groups.map((g) => (
              <button
                key={g.id}
                className="move-group-popover-item"
                onClick={() => {
                  moveToGroup(moveGroupPopover.sessionId, g.id);
                  setMoveGroupPopover(null);
                  closeMenuLocal();
                }}
              >
                {g.name}
              </button>
            ))}
            <button
              className="move-group-popover-item move-group-popover-new"
              onClick={() => {
                const name = nextGroupName();
                createGroup(name, moveGroupPopover.sessionId);
                setMoveGroupPopover(null);
                closeMenuLocal();
              }}
            >
              ＋ New group
            </button>
          </div>
        </>
      )}

      {preview && !menu && (() => {
        const s = sessions?.find((x) => x.id === preview.rowId);
        if (!s) return null;
        return (
          <SessionPreview
            cwd={s.cwd || ''}
            name={s.name || s.id}
            text={preview.text}
            anchorRect={preview.rect}
            onMouseEnter={onPreviewMouseEnter}
            onMouseLeave={onRowMouseLeave}
          />
        );
      })()}
    </aside>
  );
}
