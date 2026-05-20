import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  ApiError,
  bindSession,
  createSession,
  listClaudeSessions,
  removeSession,
} from '../lib/api';
import { useShortcut } from '../lib/shortcuts';
import type { C3Entry, ClaudeSession } from '../types';

interface Props {
  // drawer: render in modal mode (centered, focus trap, backdrop). Used
  // on viewports below 800px where the inline form fights the sidebar
  // width.
  drawer: boolean;
  // initialMode: which of the two tabs to land on. Defaults to 'new'.
  // The sidebar's "Bind existing…" entry point passes 'bind' so the
  // user doesn't have to click through the New tab first.
  initialMode?: Mode;
  onCancel: () => void;
  // onCreated fires after a successful POST /api/sessions or after a
  // bind succeeds. Caller refreshes list and auto-opens a tab.
  onCreated: (entry: C3Entry) => void;
  showToast: (msg: string, opts?: { variant?: 'info' | 'error' | 'warning' | 'success' }) => void;
  // Bumped by Sidebar whenever the user re-clicks the kind icon whose
  // form is already open. Used as a key on a one-shot pulse overlay so
  // the user gets visual ack rather than a silent no-op.
  flashKey?: number;
}

type Mode = 'new' | 'shell' | 'bind';

function basename(p: string): string {
  if (!p) return '';
  const trimmed = p.replace(/\/+$/, '');
  const idx = trimmed.lastIndexOf('/');
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
}

// Cache the claude-sessions response for 30s so flipping between New/Bind
// or reopening the form doesn't hammer the server.
const CACHE_TTL = 30_000;
interface Cache {
  at: number;
  cwds: string[];
  unbound: ClaudeSession[];
}
let cache: Cache | null = null;

export default function NewSessionForm({ drawer, initialMode, onCancel, onCreated, showToast, flashKey }: Props) {
  // Mode is fixed by the caller (sidebar icon click) — there's no in-form
  // mode switcher anymore, so this is intentionally a const-from-prop.
  const mode: Mode = initialMode ?? 'new';
  const [cwd, setCwd] = useState('');
  const [name, setName] = useState('');
  const [nameTouched, setNameTouched] = useState(false);
  const [cwds, setCwds] = useState<string[]>([]);
  const [unbound, setUnbound] = useState<ClaudeSession[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  // Manual uuid entry in Bind mode. Accepts a full Claude uuid or any
  // unique prefix (8+ chars) that resolves against `unbound`.
  const [uuidQuery, setUuidQuery] = useState('');
  const firstInputRef = useRef<HTMLInputElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);

  // Auto-fill name from basename(cwd) until the user edits the field.
  useEffect(() => {
    if (!nameTouched) setName(basename(cwd));
  }, [cwd, nameTouched]);

  // Load claude-sessions on mount (with 30s cache).
  useEffect(() => {
    const useCache = cache && Date.now() - cache.at < CACHE_TTL;
    if (useCache && cache) {
      setCwds(cache.cwds);
      setUnbound(cache.unbound);
      return;
    }
    let cancelled = false;
    listClaudeSessions()
      .then((r) => {
        if (cancelled) return;
        cache = { at: Date.now(), cwds: r.cwds, unbound: r.unbound };
        setCwds(r.cwds);
        setUnbound(r.unbound);
      })
      .catch(() => {
        // Non-fatal: user can still type a free-text path in New mode.
        if (!cancelled) setCwds([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Drawer-mode: autofocus first input, focus trap on Tab, restore
  // focus on unmount. The Tab focus-trap stays a local listener — it
  // isn't a single key shortcut, it cycles focus inside this modal.
  // ESC is migrated to the shortcut registry (PLAN.md P-3) via the
  // useShortcut call below.
  useEffect(() => {
    if (!drawer) return;
    previouslyFocused.current = document.activeElement as HTMLElement | null;
    firstInputRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Tab' || !rootRef.current) return;
      const focusables = rootRef.current.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      );
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      previouslyFocused.current?.focus?.();
    };
  }, [drawer]);

  // ESC cancels the form in both drawer and inline modes — earlier the
  // inline path was unreachable from the keyboard which was inconsistent
  // with the drawer/NewSessionPane behavior.
  useShortcut(
    {
      id: 'newSessionForm.close',
      keys: 'Escape',
      scope: 'global',
      label: 'Close new session form',
      handler: () => onCancel(),
    },
    [onCancel],
  );

  const submitNew = useCallback(async () => {
    setError(null);
    setSubmitting(true);
    try {
      const entry = await createSession({ cwd: cwd.trim(), name: name.trim() });
      onCreated(entry);
    } catch (err) {
      if (err instanceof ApiError) {
        // Parse "validation failed: cwd: <reason>" form.
        const m = err.body.match(/^validation failed:\s*(.+)$/);
        setError(m ? m[1] : err.body || `Create failed (HTTP ${err.status})`);
      } else {
        setError('Create failed');
      }
    } finally {
      setSubmitting(false);
    }
  }, [cwd, name, onCreated]);

  // submitShell posts {kind:'shell', cwd, name} — no firstPrompt, no
  // claudeUuid. Server validates cwd (absolute + existing dir) and
  // returns the created entry; the parent auto-opens its tab. argv is
  // left as the server default ($SHELL -i) — a custom-argv knob can
  // land later if anyone asks.
  const submitShell = useCallback(async () => {
    setError(null);
    setSubmitting(true);
    try {
      const r = await fetch('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kind: 'shell',
          cwd: cwd.trim(),
          name: name.trim(),
        }),
      });
      if (!r.ok) {
        const body = (await r.text()).trim();
        throw new ApiError(r.status, body);
      }
      const entry = (await r.json()) as C3Entry;
      onCreated(entry);
    } catch (err) {
      if (err instanceof ApiError) {
        const m = err.body.match(/^validation failed:\s*(.+)$/);
        setError(m ? m[1] : err.body || `Create failed (HTTP ${err.status})`);
      } else {
        setError('Create failed');
      }
    } finally {
      setSubmitting(false);
    }
  }, [cwd, name, onCreated]);

  const chooseBind = useCallback(
    async (sess: ClaudeSession) => {
      setError(null);
      setSubmitting(true);
      // Two-step: server lacks a "create-with-uuid" route. POST a
      // pending entry, then bind. If the bind fails we roll the entry
      // back so we don't leave an orphaned pending row in the sidebar.
      const fallbackName = basename(sess.cwd) || sess.uuid.slice(0, 8);
      let createdId: string | null = null;
      try {
        const entry = await createSession({ cwd: sess.cwd, name: fallbackName });
        createdId = entry.id;
        const bound = await bindSession(entry.id, sess.uuid);
        // Invalidate cache so the bind dialog refresh excludes this uuid.
        cache = null;
        createdId = null;
        setUuidQuery('');
        onCreated(bound);
      } catch (err) {
        // Rollback the pending entry created in the first step. We force
        // the delete (no PTY can be live for an entry that's existed for
        // <100 ms). Best-effort — if rollback itself fails the user can
        // remove it manually via the menu.
        if (createdId) {
          try {
            await removeSession(createdId, true);
          } catch {
            /* best effort */
          }
        }
        if (err instanceof ApiError) {
          if (err.status === 409) {
            showToast('That Claude session is already bound — refreshing list.', {
              variant: 'warning',
            });
            cache = null;
            try {
              const r = await listClaudeSessions();
              cache = { at: Date.now(), cwds: r.cwds, unbound: r.unbound };
              setUnbound(r.unbound);
              setCwds(r.cwds);
            } catch {
              /* ignore */
            }
          } else {
            setError(err.body || `Bind failed (HTTP ${err.status})`);
          }
        } else {
          setError('Bind failed');
        }
      } finally {
        setSubmitting(false);
      }
    },
    [onCreated, showToast],
  );

  const body = (
    <div ref={rootRef} className={'newsession-form' + (drawer ? ' is-drawer' : '')}>
      {/* One-shot pulse overlay: remounted via `key` whenever the user
        * re-clicks the sidebar icon whose form is already open. Skipped
        * on initial mount (flashKey starts at 0 / undefined). */}
      {flashKey ? (
        <div key={flashKey} className="form-flash-pulse" aria-hidden="true" />
      ) : null}
      {/* No in-form mode picker: the sidebar's 3-icon strip already picked
        * the kind. To switch, the user cancels and clicks a different
        * sidebar icon. Keeping a second picker here was pure duplication. */}
      {mode === 'new' && (
        <form
          className="newsession-body"
          onSubmit={(e) => {
            e.preventDefault();
            if (!submitting) void submitNew();
          }}
        >
          <label className="field">
            <span className="field-label">cwd</span>
            <div className="field-cwd">
              <input
                ref={firstInputRef}
                type="text"
                value={cwd}
                placeholder="/absolute/path"
                onChange={(e) => {
                  setCwd(e.target.value);
                  setDropdownOpen(true);
                }}
                onFocus={() => setDropdownOpen(true)}
                onBlur={() => {
                  // delay so click on list item still fires
                  window.setTimeout(() => setDropdownOpen(false), 120);
                }}
                aria-expanded={dropdownOpen}
                aria-autocomplete="list"
                spellCheck={false}
              />
              {dropdownOpen && cwds.length > 0 && (
                <ul className="cwd-dropdown" role="listbox">
                  {cwds.slice(0, 30).map((c) => (
                    <li key={c}>
                      <button
                        type="button"
                        className="cwd-option"
                        onMouseDown={(e) => {
                          // mousedown so the field's blur doesn't fire first
                          e.preventDefault();
                          setCwd(c);
                          setDropdownOpen(false);
                        }}
                      >
                        {c}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </label>
          <label className="field">
            <span className="field-label">name</span>
            <input
              type="text"
              value={name}
              placeholder={cwd ? basename(cwd) : 'session name'}
              onChange={(e) => {
                setName(e.target.value);
                setNameTouched(true);
              }}
              spellCheck={false}
            />
          </label>
          {error && (
            <div className="newsession-error" role="alert">
              {error}
            </div>
          )}
          <div className="newsession-actions">
            <button type="button" className="btn btn-sm" onClick={onCancel} disabled={submitting}>
              Cancel
            </button>
            <button
              type="submit"
              className="btn btn-sm primary"
              disabled={submitting || !cwd.trim()}
            >
              {submitting ? 'Creating…' : 'Create'}
            </button>
          </div>
        </form>
      )}

      {mode === 'shell' && (
        <form
          className="newsession-body"
          onSubmit={(e) => {
            e.preventDefault();
            if (!submitting) void submitShell();
          }}
        >
          <label className="field">
            <span className="field-label">cwd</span>
            <div className="field-cwd">
              <input
                ref={firstInputRef}
                type="text"
                value={cwd}
                placeholder="/absolute/path"
                onChange={(e) => {
                  setCwd(e.target.value);
                  setDropdownOpen(true);
                }}
                onFocus={() => setDropdownOpen(true)}
                onBlur={() => {
                  window.setTimeout(() => setDropdownOpen(false), 120);
                }}
                aria-expanded={dropdownOpen}
                aria-autocomplete="list"
                spellCheck={false}
              />
              {dropdownOpen && cwds.length > 0 && (
                <ul className="cwd-dropdown" role="listbox">
                  {cwds.slice(0, 30).map((c) => (
                    <li key={c}>
                      <button
                        type="button"
                        className="cwd-option"
                        onMouseDown={(e) => {
                          e.preventDefault();
                          setCwd(c);
                          setDropdownOpen(false);
                        }}
                      >
                        {c}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </label>
          <label className="field">
            <span className="field-label">name</span>
            <input
              type="text"
              value={name}
              placeholder={cwd ? basename(cwd) : 'shell tab name'}
              onChange={(e) => {
                setName(e.target.value);
                setNameTouched(true);
              }}
              spellCheck={false}
            />
          </label>
          {/* No prompt textarea for shell — by design. */}
          {error && (
            <div className="newsession-error" role="alert">
              {error}
            </div>
          )}
          <div className="newsession-actions">
            <button type="button" className="btn btn-sm" onClick={onCancel} disabled={submitting}>
              Cancel
            </button>
            <button
              type="submit"
              className="btn btn-sm primary"
              disabled={submitting || !cwd.trim()}
            >
              {submitting ? 'Opening…' : 'Open shell'}
            </button>
          </div>
        </form>
      )}

      {mode === 'bind' && (
        <div className="newsession-body">
          {/* Manual uuid entry — for when the user knows the id (from
            * `claude` output, another machine, etc.) and doesn't want
            * to scroll. Resolves against `unbound` so we still have
            * the cwd to create the c3 entry with. */}
          {(() => {
            const q = uuidQuery.trim().toLowerCase();
            const matches = q.length >= 8
              ? unbound.filter((s) => s.uuid.toLowerCase().startsWith(q))
              : [];
            const resolved = matches.length === 1 ? matches[0] : null;
            const hint =
              q.length === 0
                ? ''
                : q.length < 8
                  ? 'Type at least 8 characters of the uuid.'
                  : matches.length === 0
                    ? "No unbound Claude session with that uuid prefix."
                    : matches.length > 1
                      ? `${matches.length} unbound sessions share that prefix — type more.`
                      : `Match: ${resolved!.cwd}`;
            return (
              <div className="bind-uuid-row">
                <input
                  type="text"
                  className="bind-uuid-input"
                  placeholder="Bind by Claude uuid (paste / type prefix)"
                  value={uuidQuery}
                  onChange={(e) => setUuidQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && resolved && !submitting) {
                      e.preventDefault();
                      void chooseBind(resolved);
                    }
                  }}
                  disabled={submitting}
                  aria-label="Claude session uuid"
                  spellCheck={false}
                  autoCapitalize="off"
                  autoCorrect="off"
                />
                <button
                  type="button"
                  className="btn btn-sm primary"
                  disabled={!resolved || submitting}
                  onClick={() => resolved && void chooseBind(resolved)}
                >
                  Bind
                </button>
                {hint && (
                  <div
                    className={
                      'bind-uuid-hint' +
                      (matches.length === 1 ? ' bind-uuid-hint-ok' : '')
                    }
                  >
                    {hint}
                  </div>
                )}
              </div>
            );
          })()}
          {unbound.length === 0 ? (
            <div className="empty-hint" style={{ padding: '10px 4px' }}>
              No unbound Claude sessions found.
            </div>
          ) : (
            <ul className="bind-list">
              {unbound.map((s) => (
                <li key={s.uuid}>
                  <button
                    type="button"
                    className="bind-row"
                    disabled={submitting}
                    onClick={() => void chooseBind(s)}
                  >
                    <div className="bind-row-cwd">{s.cwd}</div>
                    <div className="bind-row-meta">
                      <span className="bind-row-uuid">{s.uuid.slice(0, 8)}</span>
                      {s.summary && (
                        <span className="bind-row-msg">{s.summary}</span>
                      )}
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {error && (
            <div className="newsession-error" role="alert">
              {error}
            </div>
          )}
          <div className="newsession-actions">
            <button type="button" className="btn btn-sm" onClick={onCancel} disabled={submitting}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );

  if (!drawer) return body;
  // Drawer mode: render to body via portal so the modal is centered in
  // the viewport rather than inside the 280px sidebar drawer.
  return createPortal(
    <div className="overlay overlay-fixed" role="dialog" aria-modal="true" aria-label="New session">
      <div className="overlay-card newsession-modal">{body}</div>
    </div>,
    document.body,
  );
}
