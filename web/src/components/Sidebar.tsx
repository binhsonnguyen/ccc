import { useCallback, useRef, useState } from 'react';
import SessionRowMenu, { type MenuItem } from './SessionRowMenu';
import NewSessionForm from './NewSessionForm';
import {
  ApiError,
  archiveSession,
  renameSession,
  removeSession,
} from '../lib/api';
import type { C2Entry, Tab } from '../types';

export type SidebarView = 'active' | 'archived';

interface Props {
  sessions: C2Entry[];
  activeUuid: string | null;
  openTabs: Tab[];
  view: SidebarView;
  onViewChange: (v: SidebarView) => void;
  onOpen: (entry: C2Entry) => void;
  onRefresh: () => void;
  onSessionSelected?: () => void;
  // After mutating operations we ask App to refresh the list and maybe
  // close a tab (remove path closes the open tab if it matched the
  // removed entry).
  onAfterMutate: () => void;
  onCloseTabFor: (uuid: string) => void;
  // Drawer mode flag for the new-session form fallback.
  narrow: boolean;
  showToast: (
    msg: string,
    opts?: { variant?: 'info' | 'error' | 'warning' | 'success' },
  ) => void;
}

interface MenuState {
  rowId: string;
  x: number;
  y: number;
}

export default function Sidebar({
  sessions,
  activeUuid,
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
}: Props) {
  const openSet = new Set(openTabs.map((t) => t.claudeUuid));
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  // Set transiently when Esc dismisses the rename input; blur fires after
  // unmount and would otherwise commit the draft (PATCH). Read+reset in
  // commitRename. ref (not state) because commitRename is called in the
  // same tick as the unmount/blur sequence.
  const renameCancelledRef = useRef(false);
  const [renameDraft, setRenameDraft] = useState('');
  const [creating, setCreating] = useState(false);
  const rowRefs = useRef<Map<string, HTMLLIElement | null>>(new Map());

  const closeMenuLocal = useCallback(() => {
    const rowId = menu?.rowId;
    setMenu(null);
    if (rowId) {
      // restore focus to row
      window.setTimeout(() => {
        const el = rowRefs.current.get(rowId);
        el?.focus?.();
      }, 0);
    }
  }, [menu]);

  // --- mutation helpers ---------------------------------------------------

  const doArchive = useCallback(
    async (s: C2Entry) => {
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
    async (s: C2Entry) => {
      const wasLive = !!s.live;
      try {
        await removeSession(s.id, wasLive);
        showToast(`Removed ${s.name || s.id}`, { variant: 'info' });
        if (s.claudeUuid) onCloseTabFor(s.claudeUuid);
        onAfterMutate();
      } catch (err) {
        if (err instanceof ApiError && err.status === 409) {
          // Defensive: server returned 409 even though we didn't think
          // entry was live. Retry once with force=1.
          try {
            await removeSession(s.id, true);
            showToast(`Removed ${s.name || s.id} (force)`, { variant: 'warning' });
            if (s.claudeUuid) onCloseTabFor(s.claudeUuid);
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
    [onAfterMutate, onCloseTabFor, showToast],
  );

  const startRename = useCallback((s: C2Entry) => {
    setRenamingId(s.id);
    setRenameDraft(s.name || '');
  }, []);

  const commitRename = useCallback(
    async (s: C2Entry) => {
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
    (s: C2Entry): MenuItem[] => {
      const isOpen = !!s.claudeUuid && openSet.has(s.claudeUuid);
      const pending = !s.claudeUuid;
      const archived = view === 'archived';
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
        {
          id: 'copy-uuid',
          label: 'Copy uuid',
          disabled: pending,
          onClick: () => {
            if (s.claudeUuid) void navigator.clipboard?.writeText(s.claudeUuid);
          },
        },
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
      onOpen,
      onSessionSelected,
      openSet,
      startRename,
      view,
    ],
  );

  // segmented-control keyboard handling
  const onSegKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      onViewChange(view === 'active' ? 'archived' : 'active');
    }
  };

  const onMenuClose = useCallback(() => {
    closeMenuLocal();
  }, [closeMenuLocal]);

  const currentMenuItems = menu
    ? (() => {
        const s = sessions.find((x) => x.id === menu.rowId);
        return s ? buildMenu(s) : [];
      })()
    : [];

  return (
    <aside className="sidebar" aria-label="Sessions">
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
          onKeyDown={onSegKey}
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

        <button
          type="button"
          className={'new-session-btn' + (creating ? ' active' : '')}
          onClick={() => setCreating((v) => !v)}
          aria-expanded={creating}
        >
          <span>+ New session</span>
          <span className="new-session-chev" aria-hidden="true">
            {creating ? '▴' : '▾'}
          </span>
        </button>

        {creating && !narrow && (
          <NewSessionForm
            drawer={false}
            onCancel={() => setCreating(false)}
            onCreated={(entry) => {
              setCreating(false);
              onAfterMutate();
              // Auto-open the new entry's tab if it already has a uuid;
              // pending entries (uuid empty) will spawn-on-attach.
              onOpen(entry);
            }}
            showToast={showToast}
          />
        )}
      </div>

      {creating && narrow && (
        <NewSessionForm
          drawer={true}
          onCancel={() => setCreating(false)}
          onCreated={(entry) => {
            setCreating(false);
            onAfterMutate();
            onOpen(entry);
          }}
          showToast={showToast}
        />
      )}

      {sessions.length === 0 ? (
        <div className="empty-hint">
          {view === 'archived'
            ? 'No archived sessions.'
            : (
              <>
                No sessions yet. Run <code>claude</code> in your terminal, or click{' '}
                <em>+ New session</em>.
              </>
            )}
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
              (pending ? ' pending' : '') +
              (isOpen && !isActive ? ' open' : '');
            const cwdLabel = s.cwd || '';
            const isRenaming = renamingId === s.id;

            const onRowKey = (e: React.KeyboardEvent<HTMLLIElement>) => {
              if (isRenaming) return;
              if (e.key === 'Enter') {
                e.preventDefault();
                // Pending entries open too: server spawns claude no-resume
                // (D-7) and sends {type:'pending'} → {type:'ready'} frames
                // for the banner/disableStdin handling.
                onOpen(s);
                onSessionSelected?.();
              } else if (e.key === 'r') {
                e.preventDefault();
                startRename(s);
              } else if (e.key === 'a') {
                e.preventDefault();
                void doArchive(s);
              } else if (e.key === 'Delete' || e.key === 'Backspace') {
                e.preventDefault();
                // open menu in danger-armed state via the controller:
                // simplest path is just to open the menu — user picks
                // Remove and confirms. Avoids a second confirm UI.
                const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                setMenu({ rowId: s.id, x: rect.right - 200, y: rect.bottom });
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
                className={className}
                onClick={() => {
                  if (isRenaming) return;
                  onOpen(s);
                  onSessionSelected?.();
                }}
                onKeyDown={onRowKey}
                onContextMenu={(e) => {
                  e.preventDefault();
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
                title={cwdLabel}
              >
                <div className="session-name">
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
                      <span className="session-name-text">{s.name || s.id}</span>
                      {pending && <span className="badge">pending</span>}
                      {s.live && !pending && (
                        <span className="badge badge-live" title="PTY live">
                          live
                        </span>
                      )}
                      {isOpen && !pending && (
                        <span className="dot" aria-label="Open in tab" />
                      )}
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
          })}
        </ul>
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
    </aside>
  );
}
