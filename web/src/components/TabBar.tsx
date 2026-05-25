import { useCallback, useEffect, useRef, useState } from 'react';
import { useShortcut } from '../lib/shortcuts';
import { cwdTint } from '../lib/cwdTint';
import { focusedPane, primaryPane, type Tab } from '../types';

interface Props {
  tabs: Tab[];
  activeTabId: string | null;
  onSelect: (tabId: string) => void;
  // Close all panes in a tab (drops the tab). Mapped from older
  // closeTab(uuid) signature; the App layer fans this out across panes.
  onCloseTab: (tabId: string) => void;
  // Kill the focused pane's PTY. App resolves focusedPane(tab) and
  // dispatches to ptymgr.
  onKill: (tabId: string) => void;
  // New tab-id order after a drag-drop.
  onReorder: (tabIds: string[]) => void;
}

// Pane id derivation must match TerminalPane's wrapper id so aria-controls
// points at a real node. We now key on the pane's c3Id (was claudeUuid)
// because two panes inside one tab can in principle share a claudeUuid
// during a brief discovery rekey window.
export function paneId(c3Id: string): string {
  return `pane-${c3Id}`;
}
export function tabId(c3Id: string): string {
  return `tab-${c3Id}`;
}

// Mention badge sums across all panes in a tab so a 2-pane tab with
// hits in the inactive secondary still surfaces the visual cue.
function tabMentions(tab: Tab): number {
  let sum = 0;
  for (const p of tab.panes) sum += p.mentions ?? 0;
  return sum;
}

export default function TabBar({ tabs, activeTabId, onSelect, onCloseTab, onKill, onReorder }: Props) {
  const tabbarRef = useRef<HTMLDivElement | null>(null);
  const [overflow, setOverflow] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const chevronRef = useRef<HTMLButtonElement | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [overState, setOverState] = useState<{ id: string; side: 'left' | 'right' } | null>(null);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const confirmTimerRef = useRef<number | null>(null);
  const tabRefs = useRef<Map<string, HTMLDivElement | null>>(new Map());

  const disarm = useCallback(() => {
    setConfirmingId(null);
    if (confirmTimerRef.current) {
      window.clearTimeout(confirmTimerRef.current);
      confirmTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    return () => {
      if (confirmTimerRef.current) window.clearTimeout(confirmTimerRef.current);
    };
  }, []);

  const handleKillClick = useCallback(
    (id: string, killing: boolean | undefined) => {
      if (killing) return;
      if (confirmingId === id) {
        disarm();
        onKill(id);
        return;
      }
      setConfirmingId(id);
      if (confirmTimerRef.current) window.clearTimeout(confirmTimerRef.current);
      confirmTimerRef.current = window.setTimeout(() => {
        setConfirmingId(null);
        confirmTimerRef.current = null;
      }, 3000);
    },
    [confirmingId, disarm, onKill],
  );

  const focusTab = useCallback((id: string) => {
    const el = tabRefs.current.get(id);
    if (el) el.focus();
  }, []);

  const onTabKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>, id: string) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        onSelect(id);
      }
    },
    [onSelect],
  );

  const focusedId = (): string | null => {
    const el = document.activeElement;
    if (!el) return null;
    const tabEl = el.closest<HTMLElement>('[data-tab-id]');
    return tabEl?.dataset.tabId ?? null;
  };

  useShortcut(
    {
      id: 'tabbar.prev',
      keys: 'ArrowLeft',
      scope: 'tab-focused',
      label: 'Previous tab',
      handler: () => {
        const id = focusedId();
        if (id === null || tabs.length === 0) return;
        const idx = tabs.findIndex((t) => t.id === id);
        if (idx < 0) return;
        const next = tabs[(idx - 1 + tabs.length) % tabs.length];
        onSelect(next.id);
        focusTab(next.id);
      },
    },
    [tabs, onSelect, focusTab],
  );
  useShortcut(
    {
      id: 'tabbar.next',
      keys: 'ArrowRight',
      scope: 'tab-focused',
      label: 'Next tab',
      handler: () => {
        const id = focusedId();
        if (id === null || tabs.length === 0) return;
        const idx = tabs.findIndex((t) => t.id === id);
        if (idx < 0) return;
        const next = tabs[(idx + 1) % tabs.length];
        onSelect(next.id);
        focusTab(next.id);
      },
    },
    [tabs, onSelect, focusTab],
  );
  useShortcut(
    {
      id: 'tabbar.first',
      keys: 'Home',
      scope: 'tab-focused',
      label: 'First tab',
      handler: () => {
        if (tabs.length === 0) return;
        onSelect(tabs[0].id);
        focusTab(tabs[0].id);
      },
    },
    [tabs, onSelect, focusTab],
  );
  useShortcut(
    {
      id: 'tabbar.last',
      keys: 'End',
      scope: 'tab-focused',
      label: 'Last tab',
      handler: () => {
        if (tabs.length === 0) return;
        const last = tabs[tabs.length - 1];
        onSelect(last.id);
        focusTab(last.id);
      },
    },
    [tabs, onSelect, focusTab],
  );
  useShortcut(
    {
      id: 'tabbar.close.delete',
      keys: 'Delete',
      scope: 'tab-focused',
      label: 'Close focused tab',
      handler: () => {
        const id = focusedId();
        if (id) onCloseTab(id);
      },
    },
    [onCloseTab],
  );
  useShortcut(
    {
      id: 'tabbar.close.backspace',
      keys: 'Backspace',
      scope: 'tab-focused',
      label: 'Close focused tab',
      handler: () => {
        const id = focusedId();
        if (id) onCloseTab(id);
      },
    },
    [onCloseTab],
  );

  useEffect(() => {
    const el = tabbarRef.current;
    if (!el) {
      setOverflow(false);
      return;
    }
    const recalc = () => setOverflow(el.scrollWidth > el.clientWidth + 1);
    recalc();
    const ro = new ResizeObserver(recalc);
    ro.observe(el);
    return () => ro.disconnect();
  }, [tabs.length]);

  useEffect(() => {
    if (!menuOpen) return;
    const onDoc = (e: MouseEvent) => {
      const tgt = e.target as Node | null;
      if (!tgt) return;
      if (chevronRef.current?.contains(tgt)) return;
      const menu = document.getElementById('tabbar-overflow-menu');
      if (menu && menu.contains(tgt)) return;
      setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setMenuOpen(false);
        chevronRef.current?.focus();
      }
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);

  const scrollIntoView = useCallback((id: string) => {
    const el = tabRefs.current.get(id);
    el?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, []);

  // ---- drag-reorder helpers -------------------------------------------------
  const onTabDragStart = (e: React.DragEvent<HTMLDivElement>, id: string) => {
    e.dataTransfer.setData('text/plain', id);
    e.dataTransfer.effectAllowed = 'move';
    setDraggingId(id);
  };
  const onTabDragOver = (e: React.DragEvent<HTMLDivElement>, id: string) => {
    if (!draggingId || draggingId === id) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
    const side: 'left' | 'right' = e.clientX < rect.left + rect.width / 2 ? 'left' : 'right';
    setOverState((cur) =>
      cur && cur.id === id && cur.side === side ? cur : { id, side },
    );
  };
  const onTabDrop = (e: React.DragEvent<HTMLDivElement>, targetId: string) => {
    e.preventDefault();
    const dragged = e.dataTransfer.getData('text/plain') || draggingId;
    setDraggingId(null);
    setOverState(null);
    if (!dragged || dragged === targetId) return;
    const order = tabs.map((t) => t.id);
    const from = order.indexOf(dragged);
    const to = order.indexOf(targetId);
    if (from < 0 || to < 0) return;
    const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
    const side: 'left' | 'right' = e.clientX < rect.left + rect.width / 2 ? 'left' : 'right';
    let insertAt = side === 'left' ? to : to + 1;
    order.splice(from, 1);
    if (from < insertAt) insertAt -= 1;
    if (insertAt === from) return;
    order.splice(insertAt, 0, dragged);
    onReorder(order);
  };
  const onTabDragEnd = () => {
    setDraggingId(null);
    setOverState(null);
  };

  if (tabs.length === 0) return <div className="tabbar empty" role="presentation" />;

  return (
    <div className="tabbar-wrap">
      <div
        ref={tabbarRef}
        className={'tabbar' + (overflow ? ' has-overflow' : '')}
        role="tablist"
        aria-label="Open sessions"
      >
      {tabs.map((t) => {
        const primary = primaryPane(t);
        const focused = focusedPane(t);
        const isActive = t.id === activeTabId;
        const armed = confirmingId === t.id;
        const isDragging = draggingId === t.id;
        const isOver = overState?.id === t.id;
        const overSide = isOver ? overState!.side : null;
        const tabStyle = { ['--tab-tint' as string]: cwdTint(primary.cwd || '') } as React.CSSProperties;
        const mentions = tabMentions(t);
        return (
          <div
            key={t.id}
            ref={(el) => {
              tabRefs.current.set(t.id, el);
            }}
            id={tabId(primary.c3Id)}
            data-tab-id={t.id}
            className={
              'tab' +
              (isActive ? ' active' : '') +
              (isDragging ? ' dragging' : '') +
              (overSide === 'left' ? ' drag-over-left' : '') +
              (overSide === 'right' ? ' drag-over-right' : '')
            }
            style={tabStyle}
            onClick={() => onSelect(t.id)}
            onKeyDown={(e) => onTabKeyDown(e, t.id)}
            draggable
            onDragStart={(e) => onTabDragStart(e, t.id)}
            onDragOver={(e) => onTabDragOver(e, t.id)}
            onDrop={(e) => onTabDrop(e, t.id)}
            onDragEnd={onTabDragEnd}
            tabIndex={isActive ? 0 : -1}
            role="tab"
            aria-selected={isActive}
            aria-controls={paneId(focused.c3Id)}
            title={`${primary.name} — ${primary.cwd}`}
          >
            <span className={`tab-status status-${primary.status}`} aria-hidden="true" />
            {primary.kind === 'shell' && (
              <span className="tab-kind-badge" aria-label="shell tab" title="shell tab">
                sh
              </span>
            )}
            <span className="tab-name">{primary.name}</span>
            {!isActive && mentions > 0 ? (
              <span
                className="tab-mentions"
                aria-label={`${mentions} new mention${mentions === 1 ? '' : 's'}`}
                key={mentions}
              >
                {mentions > 99 ? '99+' : mentions}
              </span>
            ) : null}
            <button
              tabIndex={-1}
              draggable={false}
              className={'tab-kill' + (armed ? ' armed' : '')}
              disabled={focused.killing}
              onClick={(e) => {
                e.stopPropagation();
                handleKillClick(t.id, focused.killing);
              }}
              onBlur={() => {
                if (armed) disarm();
              }}
              title={
                focused.killing
                  ? 'Killing…'
                  : armed
                    ? 'Click again to confirm kill'
                    : 'Kill focused pane PTY'
              }
              aria-label={armed ? 'Confirm kill PTY' : 'Kill PTY'}
            >
              {focused.killing ? '…' : armed ? '?' : '⏻'}
            </button>
            <button
              tabIndex={-1}
              draggable={false}
              className="tab-close"
              disabled={focused.killing}
              onClick={(e) => {
                e.stopPropagation();
                if (focused.killing) return;
                onCloseTab(t.id);
              }}
              title="Detach (close tab; PTY keeps running, reattach later)"
              aria-label="Detach tab"
            >
              ×
            </button>
          </div>
        );
      })}
      </div>
      {overflow && (
        <button
          ref={chevronRef}
          type="button"
          className="tabbar-chevron"
          aria-label="Show all tabs"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((v) => !v)}
        >
          ▾
        </button>
      )}
      {menuOpen && (
        <div
          id="tabbar-overflow-menu"
          className="tabbar-overflow-menu"
          role="menu"
          aria-label="All tabs"
        >
          {tabs.map((t) => {
            const primary = primaryPane(t);
            return (
              <button
                key={t.id}
                type="button"
                role="menuitem"
                className={
                  'tabbar-overflow-item' + (t.id === activeTabId ? ' active' : '')
                }
                onClick={() => {
                  onSelect(t.id);
                  scrollIntoView(t.id);
                  setMenuOpen(false);
                  chevronRef.current?.focus();
                }}
              >
                <span
                  className={`tab-status status-${primary.status}`}
                  aria-hidden="true"
                />
                <span className="tabbar-overflow-name">{primary.name}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
