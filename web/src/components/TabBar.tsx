import { useCallback, useEffect, useRef, useState } from 'react';
import { useShortcut } from '../lib/shortcuts';
import type { Tab } from '../types';

interface Props {
  tabs: Tab[];
  activeUuid: string | null;
  onSelect: (uuid: string) => void;
  onClose: (uuid: string) => void;
  onKill: (uuid: string) => void;
  // New uuid order after a drag-drop. App owns the tabs[] array; we lift
  // the reorder request rather than mutate it locally.
  onReorder: (uuids: string[]) => void;
}

// Pane id derivation must match TerminalPane's wrapper id so aria-controls
// points at a real node.
export function paneId(uuid: string): string {
  return `pane-${uuid}`;
}
export function tabId(uuid: string): string {
  return `tab-${uuid}`;
}

export default function TabBar({ tabs, activeUuid, onSelect, onClose, onKill, onReorder }: Props) {
  // Overflow detection (B-4). We measure scrollWidth vs clientWidth on
  // resize + when tabs change. ResizeObserver is the cheap path; we
  // don't poll. State drives the fade-mask class + chevron visibility.
  const tabbarRef = useRef<HTMLDivElement | null>(null);
  const [overflow, setOverflow] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const chevronRef = useRef<HTMLButtonElement | null>(null);
  // Drag-reorder state. draggingUuid is the uuid currently being dragged;
  // overUuid is the tab cursor is over (for visual line indicator).
  const [draggingUuid, setDraggingUuid] = useState<string | null>(null);
  const [overState, setOverState] = useState<{ uuid: string; side: 'left' | 'right' } | null>(null);
  // confirmingUuid: which tab's kill button is in "armed" state. A second
  // click while armed actually issues the kill. Auto-disarms after 3s or
  // when user moves focus away.
  const [confirmingUuid, setConfirmingUuid] = useState<string | null>(null);
  const confirmTimerRef = useRef<number | null>(null);
  const tabRefs = useRef<Map<string, HTMLDivElement | null>>(new Map());

  const disarm = useCallback(() => {
    setConfirmingUuid(null);
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
    (uuid: string, killing: boolean | undefined) => {
      if (killing) return;
      if (confirmingUuid === uuid) {
        disarm();
        onKill(uuid);
        return;
      }
      // Arm: switch this button visually; auto-disarm in 3s.
      setConfirmingUuid(uuid);
      if (confirmTimerRef.current) window.clearTimeout(confirmTimerRef.current);
      confirmTimerRef.current = window.setTimeout(() => {
        setConfirmingUuid(null);
        confirmTimerRef.current = null;
      }, 3000);
    },
    [confirmingUuid, disarm, onKill],
  );

  const focusTab = useCallback((uuid: string) => {
    const el = tabRefs.current.get(uuid);
    if (el) el.focus();
  }, []);

  // Enter/Space activate the focused tab — these are role="tab" button
  // semantics, not app-level shortcuts. Keep them local.
  const onTabKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>, uuid: string) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        onSelect(uuid);
      }
    },
    [onSelect],
  );

  // Arrow / Home / End / Delete / Backspace tab nav lives in the
  // shortcut registry (PLAN.md P-3). Scope = 'tab-focused' so the
  // entries are inert unless a `.tabbar` descendant has focus, which
  // means the registry only fires when this tablist is the focused
  // widget. The focused tab's uuid is read off `data-tab-uuid` on the
  // role="tab" element.
  const focusedUuid = (): string | null => {
    const el = document.activeElement;
    if (!el) return null;
    const tabEl = el.closest<HTMLElement>('[data-tab-uuid]');
    return tabEl?.dataset.tabUuid ?? null;
  };

  useShortcut(
    {
      id: 'tabbar.prev',
      keys: 'ArrowLeft',
      scope: 'tab-focused',
      label: 'Previous tab',
      handler: () => {
        const uuid = focusedUuid();
        if (uuid === null || tabs.length === 0) return;
        const idx = tabs.findIndex((t) => t.claudeUuid === uuid);
        if (idx < 0) return;
        const next = tabs[(idx - 1 + tabs.length) % tabs.length];
        onSelect(next.claudeUuid);
        focusTab(next.claudeUuid);
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
        const uuid = focusedUuid();
        if (uuid === null || tabs.length === 0) return;
        const idx = tabs.findIndex((t) => t.claudeUuid === uuid);
        if (idx < 0) return;
        const next = tabs[(idx + 1) % tabs.length];
        onSelect(next.claudeUuid);
        focusTab(next.claudeUuid);
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
        onSelect(tabs[0].claudeUuid);
        focusTab(tabs[0].claudeUuid);
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
        onSelect(last.claudeUuid);
        focusTab(last.claudeUuid);
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
        const uuid = focusedUuid();
        if (uuid) onClose(uuid);
      },
    },
    [onClose],
  );
  useShortcut(
    {
      id: 'tabbar.close.backspace',
      keys: 'Backspace',
      scope: 'tab-focused',
      label: 'Close focused tab',
      handler: () => {
        const uuid = focusedUuid();
        if (uuid) onClose(uuid);
      },
    },
    [onClose],
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

  // Close the overflow menu on outside click / ESC. Keep the listener
  // attachment cheap — only while the menu is open.
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

  const scrollIntoView = useCallback((uuid: string) => {
    const el = tabRefs.current.get(uuid);
    el?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, []);

  // ---- drag-reorder helpers -------------------------------------------------
  const onTabDragStart = (e: React.DragEvent<HTMLDivElement>, uuid: string) => {
    e.dataTransfer.setData('text/plain', uuid);
    e.dataTransfer.effectAllowed = 'move';
    setDraggingUuid(uuid);
  };
  const onTabDragOver = (e: React.DragEvent<HTMLDivElement>, uuid: string) => {
    if (!draggingUuid || draggingUuid === uuid) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
    const side: 'left' | 'right' = e.clientX < rect.left + rect.width / 2 ? 'left' : 'right';
    setOverState((cur) =>
      cur && cur.uuid === uuid && cur.side === side ? cur : { uuid, side },
    );
  };
  const onTabDrop = (e: React.DragEvent<HTMLDivElement>, targetUuid: string) => {
    e.preventDefault();
    const dragged = e.dataTransfer.getData('text/plain') || draggingUuid;
    setDraggingUuid(null);
    setOverState(null);
    if (!dragged || dragged === targetUuid) return;
    const order = tabs.map((t) => t.claudeUuid);
    const from = order.indexOf(dragged);
    const to = order.indexOf(targetUuid);
    if (from < 0 || to < 0) return;
    // Drop-on-self / drop-on-adjacent-same-side = no-op (cursor side
    // matches current relative position).
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
    setDraggingUuid(null);
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
        const isActive = t.claudeUuid === activeUuid;
        const armed = confirmingUuid === t.claudeUuid;
        const isDragging = draggingUuid === t.claudeUuid;
        const isOver = overState?.uuid === t.claudeUuid;
        const overSide = isOver ? overState!.side : null;
        return (
          <div
            key={t.claudeUuid}
            ref={(el) => {
              tabRefs.current.set(t.claudeUuid, el);
            }}
            id={tabId(t.claudeUuid)}
            data-tab-uuid={t.claudeUuid}
            className={
              'tab' +
              (isActive ? ' active' : '') +
              (isDragging ? ' dragging' : '') +
              (overSide === 'left' ? ' drag-over-left' : '') +
              (overSide === 'right' ? ' drag-over-right' : '')
            }
            onClick={() => onSelect(t.claudeUuid)}
            onKeyDown={(e) => onTabKeyDown(e, t.claudeUuid)}
            draggable
            onDragStart={(e) => onTabDragStart(e, t.claudeUuid)}
            onDragOver={(e) => onTabDragOver(e, t.claudeUuid)}
            onDrop={(e) => onTabDrop(e, t.claudeUuid)}
            onDragEnd={onTabDragEnd}
            // Roving tabindex: only the active tab participates in Tab order.
            tabIndex={isActive ? 0 : -1}
            role="tab"
            aria-selected={isActive}
            aria-controls={paneId(t.claudeUuid)}
            title={`${t.name} — ${t.cwd}`}
          >
            <span className={`tab-status status-${t.status}`} aria-hidden="true" />
            <span className="tab-name">{t.name}</span>
            <button
              // tabIndex=-1: keep Tab key skipping these so the tablist
              // stays one focus stop. Users kill via Delete key or click.
              tabIndex={-1}
              // draggable=false so press-and-hold on the button doesn't
              // bubble into the parent tab's HTML5 dragstart and turn a
              // mis-aimed kill click into a reorder gesture.
              draggable={false}
              className={'tab-kill' + (armed ? ' armed' : '')}
              disabled={t.killing}
              onClick={(e) => {
                e.stopPropagation();
                handleKillClick(t.claudeUuid, t.killing);
              }}
              onBlur={() => {
                if (armed) disarm();
              }}
              title={
                t.killing
                  ? 'Killing…'
                  : armed
                    ? 'Click again to confirm kill'
                    : 'Kill claude process (terminates PTY; lose scrollback)'
              }
              aria-label={armed ? 'Confirm kill PTY' : 'Kill PTY'}
            >
              {t.killing ? '…' : armed ? '?' : '⏻'}
            </button>
            <button
              tabIndex={-1}
              // see tab-kill above
              draggable={false}
              className="tab-close"
              disabled={t.killing}
              onClick={(e) => {
                e.stopPropagation();
                if (t.killing) return;
                onClose(t.claudeUuid);
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
          {tabs.map((t) => (
            <button
              key={t.claudeUuid}
              type="button"
              role="menuitem"
              className={
                'tabbar-overflow-item' +
                (t.claudeUuid === activeUuid ? ' active' : '')
              }
              onClick={() => {
                onSelect(t.claudeUuid);
                scrollIntoView(t.claudeUuid);
                setMenuOpen(false);
                chevronRef.current?.focus();
              }}
            >
              <span
                className={`tab-status status-${t.status}`}
                aria-hidden="true"
              />
              <span className="tabbar-overflow-name">{t.name}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
