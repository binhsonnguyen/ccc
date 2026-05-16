import { useCallback, useEffect, useRef, useState } from 'react';
import { useShortcut } from '../lib/shortcuts';
import type { Tab } from '../types';

interface Props {
  tabs: Tab[];
  activeUuid: string | null;
  onSelect: (uuid: string) => void;
  onClose: (uuid: string) => void;
  onKill: (uuid: string) => void;
}

// Pane id derivation must match TerminalPane's wrapper id so aria-controls
// points at a real node.
export function paneId(uuid: string): string {
  return `pane-${uuid}`;
}
export function tabId(uuid: string): string {
  return `tab-${uuid}`;
}

export default function TabBar({ tabs, activeUuid, onSelect, onClose, onKill }: Props) {
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

  if (tabs.length === 0) return <div className="tabbar empty" role="presentation" />;

  return (
    <div className="tabbar" role="tablist" aria-label="Open sessions">
      {tabs.map((t) => {
        const isActive = t.claudeUuid === activeUuid;
        const armed = confirmingUuid === t.claudeUuid;
        return (
          <div
            key={t.claudeUuid}
            ref={(el) => {
              tabRefs.current.set(t.claudeUuid, el);
            }}
            id={tabId(t.claudeUuid)}
            data-tab-uuid={t.claudeUuid}
            className={'tab' + (isActive ? ' active' : '')}
            onClick={() => onSelect(t.claudeUuid)}
            onKeyDown={(e) => onTabKeyDown(e, t.claudeUuid)}
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
  );
}
