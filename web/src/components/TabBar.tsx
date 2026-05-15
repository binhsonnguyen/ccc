import { useCallback, useEffect, useRef, useState } from 'react';
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

  const onTabKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>, uuid: string) => {
      const idx = tabs.findIndex((t) => t.claudeUuid === uuid);
      if (idx < 0) return;
      switch (e.key) {
        case 'ArrowLeft': {
          e.preventDefault();
          const next = tabs[(idx - 1 + tabs.length) % tabs.length];
          onSelect(next.claudeUuid);
          focusTab(next.claudeUuid);
          break;
        }
        case 'ArrowRight': {
          e.preventDefault();
          const next = tabs[(idx + 1) % tabs.length];
          onSelect(next.claudeUuid);
          focusTab(next.claudeUuid);
          break;
        }
        case 'Home': {
          e.preventDefault();
          onSelect(tabs[0].claudeUuid);
          focusTab(tabs[0].claudeUuid);
          break;
        }
        case 'End': {
          e.preventDefault();
          const last = tabs[tabs.length - 1];
          onSelect(last.claudeUuid);
          focusTab(last.claudeUuid);
          break;
        }
        case 'Delete':
        case 'Backspace': {
          e.preventDefault();
          onClose(uuid);
          break;
        }
        case 'Enter':
        case ' ': {
          e.preventDefault();
          onSelect(uuid);
          break;
        }
      }
    },
    [tabs, onSelect, onClose, focusTab],
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
