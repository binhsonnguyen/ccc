import type { C2Entry, Tab } from '../types';

interface Props {
  sessions: C2Entry[];
  activeUuid: string | null;
  openTabs: Tab[];
  onOpen: (entry: C2Entry) => void;
  onRefresh: () => void;
  // Drawer mode invoked by hamburger button (A8). Sidebar itself doesn't
  // need to know it's in a drawer; we just want to optionally auto-close
  // on selection.
  onSessionSelected?: () => void;
}

// Sidebar shows raw C2Entry list. We don't filter pending entries out —
// surfacing them (disabled) is more informative than hiding them.
export default function Sidebar({
  sessions,
  activeUuid,
  openTabs,
  onOpen,
  onRefresh,
  onSessionSelected,
}: Props) {
  const openSet = new Set(openTabs.map((t) => t.claudeUuid));
  return (
    <aside className="sidebar" aria-label="Sessions">
      <header className="sidebar-header">
        <h1>Sessions</h1>
        <button className="icon-btn" onClick={onRefresh} title="Refresh" aria-label="Refresh sessions">
          ↻
        </button>
      </header>
      {sessions.length === 0 ? (
        <div className="empty-hint">
          No sessions yet. Run <code>claude</code> in your terminal to create one.
        </div>
      ) : (
        <ul className="session-list">
          {sessions.map((s) => {
            const pending = !s.claudeUuid;
            const isActive = !pending && s.claudeUuid === activeUuid;
            const isOpen = !pending && openSet.has(s.claudeUuid);
            const className =
              'session' +
              (isActive ? ' active' : '') +
              (pending ? ' disabled' : '') +
              (isOpen && !isActive ? ' open' : '');
            const cwdLabel = s.cwd || '';
            if (pending) {
              // Non-interactive: not focusable, no role="button". Tooltip
              // explains *why* it's disabled rather than just looking dim.
              return (
                <li
                  key={s.id}
                  className={className}
                  aria-disabled="true"
                  title="Session pending: Claude UUID will link on next `c2`"
                >
                  <div className="session-name">
                    {s.name || s.id}
                    <span className="badge">pending</span>
                  </div>
                  <div className="session-cwd">{cwdLabel}</div>
                </li>
              );
            }
            return (
              <li
                key={s.id}
                className={className}
                onClick={() => {
                  onOpen(s);
                  onSessionSelected?.();
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onOpen(s);
                    onSessionSelected?.();
                  }
                }}
                tabIndex={0}
                role="button"
                aria-current={isActive ? 'true' : undefined}
                title={cwdLabel}
              >
                <div className="session-name">
                  {s.name || s.id}
                  {isOpen && <span className="dot" aria-label="Open in tab" />}
                </div>
                <div className="session-cwd">{cwdLabel}</div>
                <div className="session-uuid">{s.claudeUuid.slice(0, 8)}</div>
              </li>
            );
          })}
        </ul>
      )}
    </aside>
  );
}
