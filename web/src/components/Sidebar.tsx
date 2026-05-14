import type { C2Entry, Tab } from '../types';

interface Props {
  sessions: C2Entry[];
  activeUuid: string | null;
  openTabs: Tab[];
  onOpen: (entry: C2Entry) => void;
  onRefresh: () => void;
}

// Sidebar shows raw C2Entry list. We don't filter pending entries out —
// surfacing them (disabled) is more informative than hiding them.
export default function Sidebar({ sessions, activeUuid, openTabs, onOpen, onRefresh }: Props) {
  const openSet = new Set(openTabs.map((t) => t.claudeUuid));
  return (
    <aside className="sidebar">
      <header className="sidebar-header">
        <h1>Sessions</h1>
        <button className="icon-btn" onClick={onRefresh} title="Refresh">
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
            return (
              <li
                key={s.id}
                className={
                  'session' +
                  (isActive ? ' active' : '') +
                  (pending ? ' disabled' : '') +
                  (isOpen && !isActive ? ' open' : '')
                }
                onClick={() => !pending && onOpen(s)}
                onKeyDown={(e) => {
                  if (pending) return;
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onOpen(s);
                  }
                }}
                tabIndex={pending ? -1 : 0}
                role="button"
                aria-disabled={pending}
                aria-current={isActive ? 'true' : undefined}
                title={pending ? 'Pending — no Claude UUID yet' : s.cwd}
              >
                <div className="session-name">
                  {s.name || s.id}
                  {pending && <span className="badge">pending</span>}
                  {isOpen && !pending && <span className="dot" />}
                </div>
                <div className="session-cwd">{s.cwd}</div>
                {!pending && (
                  <div className="session-uuid">{s.claudeUuid.slice(0, 8)}</div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </aside>
  );
}
